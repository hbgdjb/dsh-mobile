package ai.deepseek.dsh.mobile;

import java.util.ArrayList;
import java.util.List;

/**
 * 退格决策状态机的测试。
 *
 * ============ 为什么值得单独写 ============
 *
 * 用户反馈：「一但字打到应用上，回退键就不起作用了」。
 *
 * 关键在于：**deleteSurroundingText 返回 true 不等于删掉了**。
 * 很多输入框（WebView、自绘编辑器）接了请求却什么都不做。
 * 原来的实现只看返回值，于是永远不去试删除键 —— 退格就"按下去没反应"。
 *
 * 而这段逻辑有两个极易写错的地方，真机上又极难复现：
 *
 *   1. 静默失败必须能被识别（靠回读比对，不靠返回值）
 *   2. 校验必须延迟（异步输入框当场回读还是旧内容，
 *      当场判失败会补删一次 → 一次退格删两个字）
 *
 * 所以把决策抽成 DshDelete，用假输入框在这里把每条路都跑一遍。
 *
 * 用法：
 *   javac -d out android/java/DshDelete.java tests/java/DeleteTest.java
 *   java -cp out ai.deepseek.dsh.mobile.DeleteTest
 */
public final class DeleteTest {

    private static int passed = 0;
    private static int failed = 0;

    /* ============================================================
       假输入框
       ============================================================ */

    /**
     * 一个可配置的假输入框。
     *
     * mode 决定"哪种删法在这个框上真的有效"：
     *   ok    —— 三种都正常
     *   liar  —— request 有效（标准 EditText，返回 true 且真删）
     *   silent—— request 返回 true 却什么都不做（本次要修的典型）
     *   keyonly—— 只认删除键
     *   composeonly —— 只认 composing 覆盖
     *   async —— request 要过一会儿才生效（WebView）
     */
    static final class FakeTarget implements DshDelete.Target {
        String text;
        String mode;
        /** 记录被调用的动作，用于断言顺序与次数。 */
        final List<String> calls = new ArrayList<>();
        /** 异步生效的待执行动作。 */
        final List<Runnable> pending = new ArrayList<>();

        FakeTarget(String text, String mode) {
            this.text = text;
            this.mode = mode;
        }

        @Override
        public CharSequence before(int n) {
            if (text.isEmpty()) return "";
            int from = Math.max(0, text.length() - n);
            return text.substring(from);
        }

        @Override
        public void request(int n) {
            calls.add("request:" + n);
            switch (mode) {
                case "ok":
                case "liar":
                    cut(n);
                    break;
                case "silent":
                    // 返回 true 却什么都不做 —— 就是它让退格失灵
                    break;
                case "keyonly":
                case "composeonly":
                    break;
                case "async":
                    pending.add(() -> cut(n));
                    break;
                default:
                    break;
            }
        }

        @Override
        public void key(int n) {
            calls.add("key:" + n);
            // 删除键是最普及的一条路：除了"只认 composing"的输入框，其余都认
            if (!mode.equals("composeonly")) cut(n);
        }

        @Override
        public void compose(int n) {
            calls.add("compose:" + n);
            if (mode.equals("ok") || mode.equals("composeonly")) cut(n);
        }

        private void cut(int n) {
            int len = text.length();
            int from = Math.max(0, len - n);
            text = text.substring(0, from);
        }

        List<String> actions() {
            List<String> out = new ArrayList<>();
            for (String c : calls) out.add(c.split(":")[0]);
            return out;
        }
    }

    /** 同步时钟：after 立刻执行，让状态机在测试里跑完。 */
    static final DshDelete.Clock NOW = (ms, r) -> r.run();

    /** 队列时钟：先攒着，调 flush() 再一起执行 —— 用来模拟连按。 */
    static final class QueueClock implements DshDelete.Clock {
        private final List<Runnable> q = new ArrayList<>();

        @Override
        public void after(long ms, Runnable r) {
            q.add(r);
        }

        void flush() {
            while (!q.isEmpty()) q.remove(0).run();
        }
    }

    private static void check(String name, boolean ok, String detail) {
        if (ok) {
            passed++;
            System.out.println("  ✓ " + name);
        } else {
            failed++;
            System.out.println("  ✗ " + name + (detail.isEmpty() ? "" : "\n    " + detail));
        }
    }

    public static void main(String[] args) {
        System.out.println("\n正常输入框\n");

        {
            FakeTarget t = new FakeTarget("你好世界", "ok");
            new DshDelete(t, NOW).delete(1);
            check("request 生效就收工，不再补删除键",
                    t.text.equals("你好世") && t.actions().equals(List.of("request")),
                    t.calls + " → " + t.text);
        }

        System.out.println("\n静默失败（用户遇到的那类输入框）\n");

        {
            FakeTarget t = new FakeTarget("你好世界", "silent");
            new DshDelete(t, NOW).delete(1);
            check("request 返回 true 却没删 → 退到删除键，字真的少了",
                    t.text.equals("你好世"),
                    t.calls + " → " + t.text);
            check("调用顺序是 request 后 key",
                    t.actions().equals(List.of("request", "key")),
                    String.valueOf(t.calls));
        }

        {
            FakeTarget t = new FakeTarget("abc", "keyonly");
            new DshDelete(t, NOW).delete(1);
            check("只认删除键的输入框也能删掉", t.text.equals("ab"), t.calls + " → " + t.text);
        }

        {
            FakeTarget t = new FakeTarget("abc", "composeonly");
            new DshDelete(t, NOW).delete(1);
            check("只认 composing 的输入框走到第三招",
                    t.text.equals("ab") && t.actions().equals(List.of("request", "key", "compose")),
                    t.calls + " → " + t.text);
        }

        System.out.println("\n不该动的地方\n");

        {
            FakeTarget t = new FakeTarget("", "ok");
            new DshDelete(t, NOW).delete(1);
            check("光标在最前面时什么都不做（避免误触返回）",
                    t.calls.isEmpty(), String.valueOf(t.calls));
        }

        {
            FakeTarget t = new FakeTarget("abc", "silent");
            new DshDelete(t, NOW).delete(3);
            check("一次删多个字符", t.text.isEmpty(), t.calls + " → '" + t.text + "'");
        }

        System.out.println("\n连按与异步\n");

        {
            // 连按两下：第二条要并进同一条链，最后只补一次 key(2)，
            // 而不是每条链各补一次（那会删过头）
            FakeTarget t = new FakeTarget("abcdef", "silent");
            QueueClock clock = new QueueClock();
            DshDelete d = new DshDelete(t, clock);
            d.delete(1);
            d.delete(1);
            check("连按时两条都发 request",
                    t.actions().equals(List.of("request", "request")),
                    String.valueOf(t.calls));
            clock.flush();
            check("连按只补一次删除键，且次数合起来算",
                    t.calls.contains("key:2") && t.text.equals("abcd"),
                    t.calls + " → '" + t.text + "'");
            check("补一次够用就不再走第三招",
                    t.actions().indexOf("compose") < 0, String.valueOf(t.calls));
        }

        {
            // 异步生效的输入框：请求其实会成功，但当场回读还是旧内容。
            // 校验链等了一拍再回读，应该看到已经删掉，不该补删除键。
            FakeTarget t = new FakeTarget("abcdef", "async");
            DshDelete d = new DshDelete(t, (ms, r) -> {
                // 模拟"延迟期间输入框把改动落了盘"
                for (Runnable p : new ArrayList<>(t.pending)) p.run();
                t.pending.clear();
                r.run();
            });
            d.delete(1);
            check("异步输入框不被误判（不会删两个字）",
                    t.text.equals("abcde"), t.calls + " → " + t.text);
            check("异步生效时不补发删除键",
                    t.actions().equals(List.of("request")), String.valueOf(t.calls));
        }

        System.out.println(failed == 0
                ? "\n全部通过（" + passed + " 项）\n"
                : "\n" + failed + " 项失败，pass=" + passed + "\n");
        System.exit(failed == 0 ? 0 : 1);
    }
}
