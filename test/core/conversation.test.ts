import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { ConversationStore, newConversation, recordTask, renderMemory, type TaskMemory } from '../../src/core/conversation.js';

const task = (over: Partial<TaskMemory> = {}): TaskMemory => ({ prompt: 'make a snake game', outcome: 'done', files: ['index.html'], reply: 'Created the game.', at: '2026-01-01', ...over });

describe('renderMemory', () => {
  it('is empty for a new conversation', () => {
    expect(renderMemory(newConversation())).toBe('');
  });
  it('lists earlier tasks with outcome, plan, files and the last reply', () => {
    const c = newConversation();
    recordTask(c, task({ summary: 'Canvas snake in three steps' }));
    const m = renderMemory(c);
    expect(m).toContain('User: "make a snake game" → done');
    expect(m).toContain('plan: Canvas snake in three steps');
    expect(m).toContain('files: index.html');
    expect(m).toContain('you said: "Created the game."');
  });
  it('compresses old tasks to one line and drops the oldest when over budget', () => {
    const c = newConversation();
    for (let i = 0; i < 12; i++) recordTask(c, task({ prompt: `task number ${i}`, reply: 'r'.repeat(400) }));
    const m = renderMemory(c, 1200);
    expect(m.length).toBeLessThanOrEqual(1200);
    expect(m).toContain('task number 11');
    expect(m).not.toContain('task number 0"');
    const full = renderMemory(c, 100_000).split('\n');
    expect(full[0]).not.toContain('you said');
    expect(full.at(-1)).toContain('you said');
  });
  it('caps stored tasks and clips long fields', () => {
    const c = newConversation();
    for (let i = 0; i < 40; i++) recordTask(c, task({ prompt: 'p'.repeat(1000) }));
    expect(c.tasks).toHaveLength(30);
    expect(c.tasks[0]?.prompt.length).toBeLessThanOrEqual(400);
  });
});

describe('ConversationStore', () => {
  const path = () => join(mkdtempSync(join(tmpdir(), 'smart-conv-')), 'nested', 'c.json');
  it('round-trips a conversation per directory', () => {
    const s = new ConversationStore(path());
    const c = newConversation();
    c.sessionId = 'sess-1';
    c.lastTier = 'sonnet';
    recordTask(c, task());
    expect(s.save('/proj/a', c)).toBeNull();
    expect(s.save('/proj/b', newConversation())).toBeNull();
    const back = s.load('/proj/a')!;
    expect(back.sessionId).toBe('sess-1');
    expect(back.lastTier).toBe('sonnet');
    expect(back.tasks).toHaveLength(1);
    expect(s.load('/proj/missing')).toBeNull();
  });
  it('tolerates a corrupt file and reports unwritable paths instead of throwing', () => {
    const p = path();
    const s = new ConversationStore(p);
    s.save('/x', newConversation());
    writeFileSync(p, '{nope');
    expect(s.load('/x')).toBeNull();
    expect(s.save('/x', newConversation())).toBeNull();
    const dir = mkdtempSync(join(tmpdir(), 'smart-conv-'));
    writeFileSync(join(dir, 'file'), 'x');
    expect(new ConversationStore(join(dir, 'file', 'c.json')).save('/x', newConversation())).toMatch(/Could not save/);
  });
});
