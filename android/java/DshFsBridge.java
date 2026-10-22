package ai.deepseek.dsh.mobile;

import android.app.Activity;
import android.content.Intent;
import android.database.Cursor;
import android.net.Uri;
import android.os.Handler;
import android.os.Looper;
import android.provider.OpenableColumns;
import android.util.Base64;
import android.webkit.JavascriptInterface;
import android.webkit.MimeTypeMap;
import android.webkit.WebView;

import org.json.JSONArray;
import org.json.JSONObject;

import java.io.ByteArrayOutputStream;
import java.io.File;
import java.io.FileInputStream;
import java.io.FileOutputStream;
import java.io.InputStream;
import java.io.OutputStream;
import java.nio.charset.StandardCharsets;
import java.util.ArrayList;
import java.util.List;

/**
 * DSH 原生文件桥：把「工作区 / 资料库」落到手机真实目录。
 *
 * 目录（应用专属外部目录，无需任何存储权限）：
 *   /sdcard/Android/data/ai.deepseek.dsh.mobile/files/workspace/
 *   /sdcard/Android/data/ai.deepseek.dsh.mobile/files/library/
 *
 * 协议（JS -> 原生）：list/read/write/writeBinary/delete/move/clear/importFiles/exportFile
 * 协议（原生 -> JS）：window.__dshFsEvent(JSON)
 *   {id, ok:true, ...}  /  {id, ok:false, error}
 *
 * 所有磁盘 IO 都在后台线程；回调 post 回主线程再 evaluateJavascript。
 */
public class DshFsBridge {

    private static final int REQ_IMPORT = 0x5A11;
    private static final int REQ_EXPORT = 0x5A12;
    private final Activity activity;
    private final WebView webView;
    private final Handler main = new Handler(Looper.getMainLooper());
    private final File root;

    /** SAF 结果回传：MainActivity 收到 onActivityResult 后转给这里。 */
    private static DshFsBridge awaiting;

    public DshFsBridge(Activity activity, WebView webView) {
        this.activity = activity;
        this.webView = webView;
        File ext = null;
        try {
            ext = activity.getExternalFilesDir(null);
        } catch (Exception ignored) {
        }
        this.root = ext != null ? ext : activity.getFilesDir();
    }

    /* ---------------- 对外接口（JS 调用） ---------------- */

    @JavascriptInterface
    public String rootPath() {
        return root != null ? root.getAbsolutePath() : "";
    }

    @JavascriptInterface
    public void list(String id, String area, String prefix) {
        background(id, () -> {
            File dir = areaDir(area);
            JSONArray arr = new JSONArray();
            walk(dir, dir, arr);
            JSONObject out = new JSONObject();
            out.put("ok", true);
            out.put("files", arr);
            return out;
        });
    }

    @JavascriptInterface
    public void read(String id, String area, String path, boolean binary) {
        background(id, () -> {
            File f = resolve(area, path);
            if (!f.exists() || !f.isFile()) throw new IllegalStateException("文件不存在：" + path);
            JSONObject out = new JSONObject();
            out.put("ok", true);
            if (binary) {
                byte[] bytes = readAll(f);
                out.put("base64", Base64.encodeToString(bytes, Base64.NO_WRAP));
                out.put("size", bytes.length);
            } else {
                byte[] bytes = readAll(f);
                out.put("content", new String(bytes, StandardCharsets.UTF_8));
                out.put("size", bytes.length);
            }
            return out;
        });
    }

    @JavascriptInterface
    public void write(String id, String area, String path, String content) {
        background(id, () -> {
            File f = resolve(area, path);
            File parent = f.getParentFile();
            if (parent != null && !parent.exists() && !parent.mkdirs()) throw new IllegalStateException("无法创建目录");
            byte[] bytes = (content == null ? "" : content).getBytes(StandardCharsets.UTF_8);
            FileOutputStream fos = new FileOutputStream(f);
            fos.write(bytes);
            fos.close();
            JSONObject out = new JSONObject();
            out.put("ok", true);
            out.put("size", bytes.length);
            out.put("mtime", f.lastModified());
            return out;
        });
    }

    @JavascriptInterface
    public void writeBinary(String id, String area, String path, String base64, String mime) {
        background(id, () -> {
            byte[] bytes = Base64.decode(base64 == null ? "" : base64, Base64.DEFAULT);
            File f = resolve(area, path);
            File parent = f.getParentFile();
            if (parent != null && !parent.exists() && !parent.mkdirs()) throw new IllegalStateException("无法创建目录");
            FileOutputStream fos = new FileOutputStream(f);
            fos.write(bytes);
            fos.close();
            JSONObject out = new JSONObject();
            out.put("ok", true);
            out.put("size", bytes.length);
            out.put("mtime", f.lastModified());
            return out;
        });
    }

    @JavascriptInterface
    public void delete(String id, String area, String path) {
        background(id, () -> {
            File f = resolve(area, path);
            deleteTree(f);
            JSONObject out = new JSONObject();
            out.put("ok", true);
            return out;
        });
    }

    @JavascriptInterface
    public void move(String id, String fromArea, String fromPath, String toArea, String toPath) {
        background(id, () -> {
            File src = resolve(fromArea, fromPath);
            File dst = resolve(toArea, toPath);
            if (!src.exists()) throw new IllegalStateException("文件不存在：" + fromPath);
            File parent = dst.getParentFile();
            if (parent != null && !parent.exists() && !parent.mkdirs()) throw new IllegalStateException("无法创建目录");
            if (dst.exists()) deleteTree(dst);
            if (!src.renameTo(dst)) {
                // 跨目录 rename 可能失败，退化为复制后删除
                copyFile(src, dst);
                deleteTree(src);
            }
            JSONObject out = new JSONObject();
            out.put("ok", true);
            out.put("size", dst.length());
            out.put("mtime", dst.lastModified());
            return out;
        });
    }

    @JavascriptInterface
    public void clear(String id, String area) {
        background(id, () -> {
            File dir = areaDir(area);
            File[] kids = dir.listFiles();
            if (kids != null) for (File k : kids) deleteTree(k);
            JSONObject out = new JSONObject();
            out.put("ok", true);
            return out;
        });
    }

    /** 系统文件选择器导入（多选）到指定区域。 */
    @JavascriptInterface
    public void importFiles(String id, String area) {
        importFilesTo(id, area, "");
    }

    /**
     * 从手机选择文件导入到 area/subdir（subdir 为空则导入 area 根目录）。
     * 聊天附件走 uploads/，避免和工作区根目录的产物混在一起。
     */
    @JavascriptInterface
    public void importFilesTo(String id, String area, String subdir) {
        main.post(() -> {
            awaiting = this;
            pendingId = id;
            pendingArea = area;
            pendingSubdir = subdir == null ? "" : subdir.trim();
            try {
                Intent i = new Intent(Intent.ACTION_OPEN_DOCUMENT);
                i.addCategory(Intent.CATEGORY_OPENABLE);
                i.setType("*/*");
                i.putExtra(Intent.EXTRA_ALLOW_MULTIPLE, true);
                activity.startActivityForResult(i, REQ_IMPORT);
            } catch (Exception e) {
                fail(id, "无法打开文件选择器：" + e.getMessage());
            }
        });
    }

    /** 把某个文件另存到用户选择的位置（下载 / 文档）。 */
    @JavascriptInterface
    public void exportFile(String id, String area, String path) {
        main.post(() -> {
            awaiting = this;
            pendingId = id;
            pendingArea = area;
            pendingPath = path;
            try {
                File f = resolve(area, path);
                Intent i = new Intent(Intent.ACTION_CREATE_DOCUMENT);
                i.addCategory(Intent.CATEGORY_OPENABLE);
                i.setType(mimeOf(path));
                i.putExtra(Intent.EXTRA_TITLE, f.getName());
                activity.startActivityForResult(i, REQ_EXPORT);
            } catch (Exception e) {
                fail(id, "无法打开保存面板：" + e.getMessage());
            }
        });
    }

    /* ---------------- SAF 结果处理 ---------------- */

    private String pendingId;
    private String pendingArea;
    private String pendingPath;
    private String pendingSubdir = "";

    public static boolean handleActivityResult(int requestCode, int resultCode, Intent data) {
        DshFsBridge b = awaiting;
        if (b == null) return false;
        if (requestCode != REQ_IMPORT && requestCode != REQ_EXPORT) return false;
        awaiting = null;
        if (requestCode == REQ_IMPORT) {
            b.onImported(resultCode, data);
        } else {
            b.onExported(resultCode, data);
        }
        return true;
    }

    private void onImported(int resultCode, Intent data) {
        final String id = pendingId;
        final String area = pendingArea;
        pendingId = null;
        if (resultCode != Activity.RESULT_OK || data == null) {
            fail(id, "已取消导入");
            return;
        }
        final List<Uri> uris = new ArrayList<>();
        if (data.getClipData() != null) {
            for (int i = 0; i < data.getClipData().getItemCount(); i++) {
                uris.add(data.getClipData().getItemAt(i).getUri());
            }
        } else if (data.getData() != null) {
            uris.add(data.getData());
        }
        if (uris.isEmpty()) {
            fail(id, "没有选择文件");
            return;
        }
        final String subdir = pendingSubdir;
        pendingSubdir = "";
        background(id, () -> {
            File base = areaDir(area);
            File dir = subdir.isEmpty() ? base : new File(base, subdir);
            if (!dir.exists()) dir.mkdirs();
            JSONArray saved = new JSONArray();
            for (Uri uri : uris) {
                String name = displayName(uri);
                String target = uniqueName(dir, name);
                File out = new File(dir, target);
                InputStream in = activity.getContentResolver().openInputStream(uri);
                FileOutputStream fos = new FileOutputStream(out);
                byte[] buf = new byte[64 * 1024];
                int n;
                while ((n = in.read(buf)) > 0) fos.write(buf, 0, n);
                fos.close();
                in.close();
                JSONObject item = new JSONObject();
                item.put("path", subdir.isEmpty() ? target : subdir + "/" + target);
                item.put("size", out.length());
                item.put("mtime", out.lastModified());
                saved.put(item);
            }
            JSONObject res = new JSONObject();
            res.put("ok", true);
            res.put("files", saved);
            return res;
        });
    }

    private void onExported(int resultCode, Intent data) {
        final String id = pendingId;
        final String area = pendingArea;
        final String path = pendingPath;
        pendingId = null;
        pendingPath = null;
        if (resultCode != Activity.RESULT_OK || data == null || data.getData() == null) {
            fail(id, "已取消保存");
            return;
        }
        final Uri target = data.getData();
        background(id, () -> {
            File src = resolve(area, path);
            InputStream in = new FileInputStream(src);
            OutputStream out = activity.getContentResolver().openOutputStream(target);
            byte[] buf = new byte[64 * 1024];
            int n;
            while ((n = in.read(buf)) > 0) out.write(buf, 0, n);
            out.close();
            in.close();
            JSONObject res = new JSONObject();
            res.put("ok", true);
            return res;
        });
    }

    /* ---------------- 内部实现 ---------------- */

    private interface Op {
        JSONObject run() throws Exception;
    }

    private void background(String id, Op op) {
        new Thread(() -> {
            try {
                JSONObject out = op.run();
                out.put("id", id);
                emit(out);
            } catch (Exception e) {
                fail(id, e.getMessage() == null ? e.toString() : e.getMessage());
            }
        }, "dsh-fs-" + id).start();
    }

    private void fail(String id, String message) {
        try {
            JSONObject out = new JSONObject();
            out.put("id", id);
            out.put("ok", false);
            out.put("error", message);
            emit(out);
        } catch (Exception ignored) {
        }
    }

    private void emit(JSONObject payload) {
        final String js = "window.__dshFsEvent && window.__dshFsEvent(" + JSONObject.quote(payload.toString()) + ")";
        main.post(() -> {
            try {
                webView.evaluateJavascript(js, null);
            } catch (Exception ignored) {
            }
        });
    }

    /**
     * 区域目录。
     *
     * 三个区域：
     *   library  —— 资料库（用户放的文件）
     *   workspace —— 工作区（Agent 产出）
     *   traj     —— 控屏轨迹库（0.34.0 新增）
     *
     * 为什么要单独的 traj 区域，而不是塞进 workspace：
     * 轨迹是**机器生成的内部数据**，量级会持续增长（每条轨迹一个 JSON），
     * 而且需要整目录导出成语料文件做离线评测。
     * 混进 workspace 会把用户的工作区塞满内部文件 ——
     * 导出、分享、同步都会被这些文件干扰。
     *
     * 它仍在应用专属外部目录下（/sdcard/Android/data/<包名>/files/traj/），
     * 卸载即清除，不会残留到公共存储。
     */
    private File areaDir(String area) {
        String name;
        if ("library".equals(area)) {
            name = "library";
        } else if ("traj".equals(area)) {
            name = "traj";
        } else {
            name = "workspace";
        }
        File dir = new File(root, name);
        if (!dir.exists()) dir.mkdirs();
        return dir;
    }

    /** 路径必须落在区域内，防止 ../ 越界。 */
    private File resolve(String area, String path) throws Exception {
        File dir = areaDir(area);
        String rel = path == null ? "" : path.replace('\\', '/').replaceAll("^/+", "");
        if (rel.isEmpty()) throw new IllegalArgumentException("路径不能为空");
        File f = new File(dir, rel);
        String base = dir.getCanonicalPath();
        String target = f.getCanonicalPath();
        if (!target.equals(base) && !target.startsWith(base + File.separator)) {
            throw new SecurityException("路径越界：" + path);
        }
        return f;
    }

    private void walk(File base, File dir, JSONArray out) {
        File[] kids = dir.listFiles();
        if (kids == null) return;
        for (File f : kids) {
            if (f.isDirectory()) {
                walk(base, f, out);
            } else {
                try {
                    String rel = f.getAbsolutePath().substring(base.getAbsolutePath().length() + 1).replace(File.separatorChar, '/');
                    JSONObject item = new JSONObject();
                    item.put("path", rel);
                    item.put("size", f.length());
                    item.put("mtime", f.lastModified());
                    out.put(item);
                } catch (Exception ignored) {
                }
            }
        }
    }

    private static byte[] readAll(File f) throws Exception {
        FileInputStream in = new FileInputStream(f);
        ByteArrayOutputStream bos = new ByteArrayOutputStream((int) Math.max(64, f.length()));
        byte[] buf = new byte[64 * 1024];
        int n;
        while ((n = in.read(buf)) > 0) bos.write(buf, 0, n);
        in.close();
        return bos.toByteArray();
    }

    private static void copyFile(File src, File dst) throws Exception {
        FileInputStream in = new FileInputStream(src);
        FileOutputStream out = new FileOutputStream(dst);
        byte[] buf = new byte[64 * 1024];
        int n;
        while ((n = in.read(buf)) > 0) out.write(buf, 0, n);
        out.close();
        in.close();
    }

    private static void deleteTree(File f) {
        if (f.isDirectory()) {
            File[] kids = f.listFiles();
            if (kids != null) for (File k : kids) deleteTree(k);
        }
        f.delete();
    }

    private String displayName(Uri uri) {
        String name = null;
        Cursor c = null;
        try {
            c = activity.getContentResolver().query(uri, null, null, null, null);
            if (c != null && c.moveToFirst()) {
                int idx = c.getColumnIndex(OpenableColumns.DISPLAY_NAME);
                if (idx >= 0) name = c.getString(idx);
            }
        } catch (Exception ignored) {
        } finally {
            if (c != null) c.close();
        }
        if (name == null || name.trim().isEmpty()) name = "imported-" + System.currentTimeMillis();
        return name.replace("/", "_").replace("\\", "_");
    }

    private static String uniqueName(File dir, String name) {
        File f = new File(dir, name);
        if (!f.exists()) return name;
        int dot = name.lastIndexOf('.');
        String base = dot > 0 ? name.substring(0, dot) : name;
        String ext = dot > 0 ? name.substring(dot) : "";
        for (int i = 1; i < 1000; i++) {
            String candidate = base + "-" + i + ext;
            if (!new File(dir, candidate).exists()) return candidate;
        }
        return base + "-" + System.currentTimeMillis() + ext;
    }

    private static String mimeOf(String path) {
        String name = path == null ? "" : path.toLowerCase();
        if (name.endsWith(".docx")) return "application/vnd.openxmlformats-officedocument.wordprocessingml.document";
        if (name.endsWith(".xlsx")) return "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet";
        if (name.endsWith(".pptx")) return "application/vnd.openxmlformats-officedocument.presentationml.presentation";
        if (name.endsWith(".pdf")) return "application/pdf";
        if (name.endsWith(".md")) return "text/markdown";
        if (name.endsWith(".csv")) return "text/csv";
        if (name.endsWith(".json")) return "application/json";
        if (name.endsWith(".png")) return "image/png";
        if (name.endsWith(".jpg") || name.endsWith(".jpeg")) return "image/jpeg";
        String ext = MimeTypeMap.getFileExtensionFromUrl(name);
        String mime = ext == null ? null : MimeTypeMap.getSingleton().getMimeTypeFromExtension(ext);
        return mime == null ? "application/octet-stream" : mime;
    }
}
