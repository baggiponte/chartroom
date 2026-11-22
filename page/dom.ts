function byId<T extends HTMLElement>(id: string, type: new () => T): T {
  const el = document.getElementById(id);
  if (!(el instanceof type)) {
    throw new Error(`#${id} is missing`);
  }
  return el;
}

export const $ = (id: string): HTMLElement => byId(id, HTMLElement);
export const ta = byId("ta", HTMLTextAreaElement);
export const backdrop = $("backdrop");
export const pop = $("pop");
export const extrasEl = $("extras");
export const gripsEl = $("grips");
export const laneEl = $("lane");
export const hintEl = $("scrubHint");
export const moreBtn = byId("more", HTMLButtonElement);
export const tidyBtn = byId("tidy", HTMLButtonElement);
export const sendBtn = byId("send", HTMLButtonElement);
