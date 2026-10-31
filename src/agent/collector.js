/**
 * Turn 收集器：把 DSH 的会话事件流收成"一轮的最终文本"
 *
 * 来自旧项目的经验（见 vendor/README.md）：
 *  - 只有 turn/start 才建记录，避免迟到事件建出永远等不到 end 的空壳
 *  - 不要累加 assistant/chunk，assistant/message 已含完整文本（否则回复会翻倍）
 */

export function createTurnCollector() {
  const turns = new Map();

  return {
    push(event) {
      if (!event || typeof event !== 'object') return null;

      if (event.type === 'turn/start') {
        turns.set(event.data?.turn, { text: '' });
        return null;
      }
      if (event.type === 'assistant/chunk') return null;
      if (event.type === 'assistant/message') {
        const entry = turns.get(event.data?.turn);
        if (!entry) return null;
        for (const block of event.data?.message?.content ?? []) {
          if (block?.type === 'text' && typeof block.text === 'string') entry.text += block.text;
        }
        return null;
      }
      if (event.type === 'turn/end') {
        const entry = turns.get(event.data?.turn);
        turns.delete(event.data?.turn);
        if (!entry) return null;
        return { turn: event.data?.turn, reason: event.data?.reason ?? {}, text: entry.text };
      }
      return null;
    },
    has(turn) {
      return turns.has(turn);
    },
    size() {
      return turns.size;
    },
  };
}
