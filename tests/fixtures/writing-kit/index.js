/**
 * 示例插件：在输入框上方挂一条工具条。
 *
 * ============ 它演示什么 ============
 *
 * 手机端的界面宿主不能收 React 组件（函数跨不了进程），
 * 只收**一棵纯 JSON 的界面树**。这个插件把三种常见形态都用了一遍：
 *
 *   · mount      挂一块界面上去
 *   · onAction   处理点击；返回新树 = 局部更新
 *   · 工具注册    同一份能力也给 AI 用
 *
 * 把它整个目录拷到手机的 `工作区/plugins/writing-kit/`，
 * 在「插件」页重载一次就能看到。
 *
 * ============ 界面树长什么样 ============
 *
 *   { type: 'row', gap: 'sm', children: [
 *       { type: 'badge', text: '写作套件', tone: 'accent' },
 *       { type: 'button', label: '润色', action: 'polish' },
 *   ]}
 *
 * 可用类型：row / column / card / list / text / badge / button /
 *           input / switch / select / progress / image / divider / spacer
 * 只认这些 —— 这不是限制，是安全边界：插件不能写 HTML、不能写样式、
 * 不能塞脚本。颜色只能从 plain / muted / strong / accent / ok / warn / danger 里选。
 */

const STATE = new Map();

exports.inject = ['slots', 'tools'];

exports.apply = function apply(ctx) {
  const id = 'writing-kit-toolbar';

  /** 画一次工具条（状态变了就重画同 id，等于原地替换）。 */
  function paint(note) {
    const s = STATE.get(id) || { last: '' };
    STATE.set(id, s);
    const r = ctx.slots.mount(
      'composer.toolbar',
      {
        type: 'row',
        gap: 'sm',
        align: 'center',
        children: [
          { type: 'badge', text: '写作套件', tone: 'accent' },
          { type: 'text', text: note || s.last || '选中文字后可处理', tone: 'muted', size: 'sm' },
          { type: 'button', label: '润色', action: 'polish' },
          { type: 'button', label: '缩写', action: 'shorten' },
        ],
      },
      { id }
    );
    if (!r.ok) {
      // 挂不上要说出来 —— 静默失败是最难查的
      ctx.logger && ctx.logger.warn && ctx.logger.warn('界面挂载失败：' + r.error);
    }
    return r;
  }

  paint('');

  /**
   * 点击回调。
   *
   * 返回一棵树 = 更新这块界面；返回 undefined = 只当作一次事件。
   */
  ctx.slots.onAction(id, async (action) => {
    const s = STATE.get(id) || {};
    s.last = action === 'polish' ? '已润色（演示）' : '已缩写（演示）';
    STATE.set(id, s);
    return {
      type: 'row',
      gap: 'sm',
      align: 'center',
      children: [
        { type: 'badge', text: '写作套件', tone: 'accent' },
        { type: 'text', text: s.last, tone: 'ok', size: 'sm' },
        { type: 'button', label: '再来一次', action: 'polish', tone: 'ghost' },
      ],
    };
  });

  // 同一份能力也给 AI 用：模型可以调这个工具
  ctx.tools.registerTool(
    {
      name: 'writing_polish',
      description: '把一段文字润色（示例插件，只做演示）',
      parameters: {
        type: 'object',
        properties: { text: { type: 'string', description: '要润色的文字' } },
        required: ['text'],
      },
    },
    async (args) => {
      const text = String((args && args.text) || '');
      if (!text) return { ok: false, output: '缺少 text' };
      return { ok: true, output: `（示例）润色结果：${text}` };
    }
  );
};
