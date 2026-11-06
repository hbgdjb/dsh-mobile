package ai.deepseek.dsh.mobile;

/**
 * 退格的「请求 → 校验 → 换路」状态机。
 *
 * ============ 为什么要单独一个类 ============
 *
 * 这段逻辑有两个很容易写错、又很难在真机上复现的点：
 *
 *   1. **返回值不等于结果**。deleteSurroundingText 返回 true 只表示
 *      "请求我接了"，很多输入框（WebView、自绘编辑器）接了却什么都不做。
 *      只看返回值，退格就是"按下去没反应"。
 *
 *   2. **校验不能当场做**。有些输入框的删除是异步落到文本框里的，
 *      请求返回的那一瞬间回读还是旧内容。当场判"没删掉"就会补发删除键，
 *      变成一次退格删两个字。
 *
 * 所以需要一条有时序的校验链。而这条链如果写在 DshImeBridge 里，
 * 就只能靠正则断言去"看代码"，测不到行为 —— 因为 InputConnection
 * 是 Android 接口，JVM 上跑不起来。
 *
 * 抽出来之后，Android 侧只提供 {@link Target} 的四个动作，
 * 决策逻辑本身可以在 JVM 上用假对象真跑（见 tests/java/DeleteTest.java）。
 *
 * ============ 三个动作的先后 ============
 *
 *   ① request  deleteSurroundingText*  —— 语义最准，能整段删
 *   ② key      KEYCODE_DEL             —— 最普及，几乎谁都认
 *   ③ compose  选中后提交空串           —— 专治只认 composing 的自绘输入框
 *
 * 先①后②：正常输入框一次就成；① 静默失败的那些由 ② 兜住。
 * 反过来（先②）会让 WebView 这类异步输入框被误判"没删掉"，
 * 于是又补一次 ①，结果删两个字。
 */
final class DshDelete {

    /** 删除动作的实现方（Android 侧用 InputConnection 实现）。 */
    interface Target {
        /** 光标前最多 n 个字符；读不到返回 null。 */
        CharSequence before(int n);

        /** deleteSurroundingText / deleteSurroundingTextInCodePoints。 */
        void request(int n);

        /** 发 n 次 KEYCODE_DEL。 */
        void key(int n);

        /** 选中光标前 n 个字符再提交空串。 */
        void compose(int n);
    }

    /** 延迟执行器（Android 侧是 Handler.postDelayed）。 */
    interface Clock {
        void after(long ms, Runnable r);
    }

    /** 校验等待时间：够异步输入框把改动落回去，又短到用户感觉不到。 */
    static final long VERIFY_MS = 80;

    private final Target target;
    private final Clock clock;

    /** 校验链是否在跑。 */
    private boolean running = false;
    /** 链启动时"光标前"的文字快照。 */
    private CharSequence snapshot = null;
    /** 这条链累计要补删的字符数（连按会并进来）。 */
    private int count = 0;

    DshDelete(Target target, Clock clock) {
        this.target = target;
        this.clock = clock;
    }

    /**
     * 用户按了一次退格。
     *
     * @param n 要删的字符数（一般就是 1）
     */
    void delete(int n) {
        int want = Math.max(1, n);

        CharSequence before = target.before(Math.max(8, want + 1));
        // 光标已经在这个输入框最前面 —— 没得删。
        // 这里必须直接返回：有的应用把 DEL 当成「返回上一页」，
        // 在空输入框里多发一个删除键会直接把页面退掉。
        if (before != null && before.length() == 0) return;

        // ①
        target.request(want);

        count += want;
        if (running) return; // 并进已有的链，别再起一条

        running = true;
        snapshot = before;
        clock.after(VERIFY_MS, () -> step(1));
    }

    private void step(int stage) {
        if (!unchanged()) {
            // 内容变了 —— 真的删掉了，收工
            reset();
            return;
        }
        if (stage == 1) {
            // ②
            target.key(count);
            clock.after(VERIFY_MS, () -> step(2));
            return;
        }
        // ③
        target.compose(count);
        reset();
    }

    /** 光标前那段文字是否和快照一模一样（一样 = 什么都没删掉）。 */
    private boolean unchanged() {
        if (snapshot == null) return false;
        CharSequence now = target.before(snapshot.length());
        if (now == null) return false;
        return now.toString().equals(snapshot.toString());
    }

    private void reset() {
        running = false;
        snapshot = null;
        count = 0;
    }
}
