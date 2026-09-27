import type { Page } from "@playwright/test";

/// What a mocked command returns. A plain value, an error, a delayed value,
/// a list used one per call (the last one repeats), or a choice by one argument.
export type Reply =
  | unknown
  | { $error: string }
  | { $delay: number; value: unknown }
  | { $seq: unknown[] }
  | { $by: string; cases: Record<string, unknown>; otherwise?: unknown };
export type Handlers = Record<string, Reply>;

/// Fake Tauri before the app loads. Unknown commands return null.
export async function mockTauri(page: Page, handlers: Handlers) {
  await page.addInitScript((h: Handlers) => {
    const w = window as unknown as Record<string, unknown>;
    const calls: { cmd: string; args: unknown }[] = [];
    const listeners: Record<string, number[]> = {};
    const seqAt: Record<string, number> = {};
    let nextId = 1;
    w.__calls = calls;
    w.__handlers = h;
    w.__emit = (event: string, payload: unknown) => {
      for (const id of listeners[event] ?? []) (w[`_${id}`] as (e: unknown) => void)?.({ event, id, payload });
    };
    const reply = async (cmd: string, args: Record<string, unknown>): Promise<unknown> => {
      const all = w.__handlers as Handlers;
      let r = all[cmd] as Reply;
      if (r && typeof r === "object" && "$by" in r) {
        const b = r as { $by: string; cases: Record<string, unknown>; otherwise?: unknown };
        const key = String(args?.[b.$by]);
        r = key in b.cases ? b.cases[key] : b.otherwise;
      }
      if (r && typeof r === "object" && "$seq" in r) {
        const seq = (r as { $seq: unknown[] }).$seq;
        const i = seqAt[cmd] ?? 0;
        seqAt[cmd] = i + 1;
        r = seq[Math.min(i, seq.length - 1)];
      }
      if (r && typeof r === "object" && "$delay" in r) {
        const d = r as { $delay: number; value: unknown };
        await new Promise((res) => setTimeout(res, d.$delay));
        r = d.value;
      }
      if (r && typeof r === "object" && "$error" in r) throw (r as { $error: string }).$error;
      return r ?? null;
    };
    w.__TAURI_INTERNALS__ = {
      metadata: { currentWindow: { label: "main" }, currentWebview: { windowLabel: "main", label: "main" } },
      transformCallback: (cb: unknown) => { const id = nextId++; w[`_${id}`] = cb; return id; },
      unregisterCallback: (id: number) => { delete w[`_${id}`]; },
      convertFileSrc: (s: string) => s,
      invoke: async (cmd: string, args: Record<string, unknown>) => {
        calls.push({ cmd, args });
        if (cmd === "plugin:event|listen") {
          (listeners[args.event as string] ??= []).push(args.handler as number);
          return args.handler;
        }
        if (cmd.startsWith("plugin:")) return null;
        return reply(cmd, args);
      },
    };
    w.__TAURI_EVENT_PLUGIN_INTERNALS__ = { unregisterListener: () => {} };
  }, handlers);
}

/// Change what a command returns from now on.
export async function setReply(page: Page, cmd: string, reply: Reply) {
  await page.evaluate(([c, r]) => { ((window as unknown as { __handlers: Handlers }).__handlers)[c as string] = r; }, [cmd, reply] as const);
}

/// Every call to `cmd` so far, with its arguments.
export async function callsTo(page: Page, cmd: string): Promise<Record<string, unknown>[]> {
  return page.evaluate((c) => ((window as unknown as { __calls: { cmd: string; args: Record<string, unknown> }[] }).__calls).filter((x) => x.cmd === c).map((x) => x.args), cmd);
}

/// Fire a Tauri event, like the app's file watcher does.
export async function emit(page: Page, event: string, payload: unknown) {
  await page.evaluate(([e, p]) => (window as unknown as { __emit: (e: string, p: unknown) => void }).__emit(e as string, p), [event, payload] as const);
}
