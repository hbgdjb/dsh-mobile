exports.inject = ['llm'];

exports.apply = function (ctx) {
  ctx.llm.registerAdapter(['echo'], {
    providerInfo: function (p) { return { id: p, name: '回显测试' }; },
    listModels: async function (p) {
      return [{ id: 'echo-1', name: '回声模型', provider: p, contextWindow: 32000 }];
    },
    stream: function (options) {
      var msgs = options.messages || [];
      var last = msgs[msgs.length - 1] || {};
      var flat = function (c) {
        if (typeof c === 'string') return c;
        return (Array.isArray(c) ? c : []).map(function (x) { return x.text || ''; }).join('');
      };
      var body = '收到 ' + msgs.length + ' 条消息。最后一句是「' + flat(last.content) +
        '」。工具定义 ' + (options.tools || []).length + ' 个。';
      var i = 0, step = 0;
      return {
        [Symbol.asyncIterator]: function () { return this; },
        next: async function () {
          if (step === 0) { step = 1; return { value: { type: 'block-start', index: 0, blockType: 'text' } }; }
          if (i < body.length) {
            var ch = body[i]; i += 1;
            await new Promise(function (r) { setTimeout(r, 35); });
            return { value: { type: 'text-delta', index: 0, text: ch } };
          }
          if (step === 1) { step = 2; return { value: { type: 'block-end', index: 0, block: { type: 'text', text: body } } }; }
          if (step === 2) { step = 3; return { value: { type: 'finish', reason: { kind: 'stop' } } }; }
          return { value: undefined, done: true };
        }
      };
    }
  });
};
