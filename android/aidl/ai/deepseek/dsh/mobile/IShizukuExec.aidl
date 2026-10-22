// Shizuku UserService 的接口。
//
// 为什么需要它：Shizuku 13.x 起 `Shizuku.newProcess()` 已经不是公开 API
// （13.1.5 的 classes.jar 里 javap 看不到它），网上那些"一行命令执行 shell"
// 的教程全部失效了。
//
// 现在的官方路径是 UserService：
//   应用 bindUserService → Shizuku 在 shell 进程里加载本文件的实现
//   → 通过这个 AIDL 接口回调 → 实现里 Runtime.exec 就是 shell uid。
//
// 也就是说：真正的执行体跑在 shell 进程，不在应用进程。
package ai.deepseek.dsh.mobile;

interface IShizukuExec {
    /**
     * 在 shell 身份下执行一条命令，返回合并后的 stdout+stderr。
     *
     * 返回值上限 900KB（Binder 单次事务上限 1MB，留出余量）。
     */
    String exec(String cmd);
}
