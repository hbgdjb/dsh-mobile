/*
 * DshNode — Node.js 运行时的 JNI 入口。
 *
 * ============ 为什么用 dlopen 而不是静态链接 ============
 *
 * libnode.so 有 117 MB。如果直接链进 APK，安装包就从 15 MB 变成 128 MB ——
 * 用户根本没法通过常规渠道把包传到手机上（传输工具有 20 MB 的上限）。
 *
 * 所以把它改成"运行时下载到应用私有目录，再 dlopen 加载"。
 * APK 里只留这个 20 KB 的包装。
 *
 * 前提是 `node::Start` 必须是动态导出符号 —— 已验证：
 *
 *     $ readelf --dyn-syms libnode.so | grep _ZN4node5Start
 *     65996: ... FUNC GLOBAL DEFAULT 12 _ZN4node5StartEiPPc
 *
 * ============ 注意 ============
 *
 * · dlopen 的路径必须是绝对路径，且文件要可读可执行（应用私有目录满足）。
 * · node::Start 是**阻塞**的，调用方必须放在独立工作线程里。
 * · 加载失败时把 dlerror() 抛成 Java 异常，让设置页能显示具体原因 ——
 *   只返回一个 -2 的话，用户看到的就是"运行不起来"，没法定位。
 */

#include <jni.h>
#include <android/log.h>
#include <dlfcn.h>

#include <cstring>
#include <cstdlib>
#include <string>
#include <vector>

#define TAG "DshNode"
#define LOGI(...) __android_log_print(ANDROID_LOG_INFO, TAG, __VA_ARGS__)
#define LOGE(...) __android_log_print(ANDROID_LOG_ERROR, TAG, __VA_ARGS__)

/** node::Start(int argc, char** argv) 的 Itanium C++ ABI 修饰名。 */
static const char *kStartSymbol = "_ZN4node5StartEiPPc";

static void throwLinkError(JNIEnv *env, const char *what) {
    const char *detail = dlerror();
    std::string msg = std::string(what) + (detail ? std::string("：") + detail : "");
    LOGE("%s", msg.c_str());
    jclass cls = env->FindClass("java/lang/UnsatisfiedLinkError");
    if (cls != nullptr) {
        env->ThrowNew(cls, msg.c_str());
    }
}

JNIEXPORT jint JNI_OnLoad(JavaVM *vm, void *) {
    // 只返回版本号：这里不做任何加载动作，
    // 真正的 dlopen 在 nativeStart 里按需执行（库是下载来的，启动时可能还没有）
    (void) vm;
    return JNI_VERSION_1_6;
}

extern "C"
JNIEXPORT jint JNICALL
Java_ai_deepseek_dsh_mobile_DshNodeRuntime_nativeStart(
        JNIEnv *env, jclass /* cls */, jstring jlibPath, jobjectArray jargs) {
    if (jlibPath == nullptr || jargs == nullptr) {
        throwLinkError(env, "参数为空");
        return -1;
    }

    const char *libPath = env->GetStringUTFChars(jlibPath, nullptr);
    if (libPath == nullptr) {
        throwLinkError(env, "无法读取库路径");
        return -1;
    }
    LOGI("dlopen %s", libPath);
    // RTLD_GLOBAL：node::Start 内部会用到这个库自己导出的其它符号
    void *handle = dlopen(libPath, RTLD_NOW | RTLD_GLOBAL);
    env->ReleaseStringUTFChars(jlibPath, libPath);

    if (handle == nullptr) {
        throwLinkError(env, "加载 libnode.so 失败");
        return -2;
    }

    auto start = reinterpret_cast<int (*)(int, char **)>(dlsym(handle, kStartSymbol));
    if (start == nullptr) {
        throwLinkError(env, "libnode.so 里找不到 node::Start");
        return -3;
    }

    int argc = env->GetArrayLength(jargs);
    if (argc <= 0) {
        throwLinkError(env, "argv 为空");
        return -1;
    }

    // 转成 char**。每条都要 strdup —— node::Start 会长期持有这些指针，
    // 而 GetStringUTFChars 的返回值在 Release 之后就失效了。
    std::vector<char *> argv;
    argv.reserve(static_cast<size_t>(argc) + 1);
    for (int i = 0; i < argc; i += 1) {
        auto js = static_cast<jstring>(env->GetObjectArrayElement(jargs, i));
        if (js == nullptr) {
            argv.push_back(strdup(""));
            continue;
        }
        const char *c = env->GetStringUTFChars(js, nullptr);
        argv.push_back(strdup(c == nullptr ? "" : c));
        env->ReleaseStringUTFChars(js, c);
        env->DeleteLocalRef(js);
    }
    argv.push_back(nullptr);

    LOGI("node::Start 开始，argc=%d", argc);
    int rc = start(argc, argv.data());
    LOGI("node::Start 返回 rc=%d", rc);

    for (char *p : argv) free(p);
    // 不 dlclose：Node 退出后这个进程也没有继续存在的意义，
    // 而且此时可能还有线程引用库里的代码，卸载会崩。
    return rc;
}
