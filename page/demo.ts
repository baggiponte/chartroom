import type { Analysis, DecideInput, Choice as Sent } from "../skills/help-me/tasks.ts";
import type { Api } from "../skills/help-me/api.ts";
import type { Choice, Explanation } from "./state.ts";

type Reply<R extends keyof Api> = Promise<Api[R]["reply"]>;
const pause = (ms: number): Promise<void> => new Promise(r => setTimeout(r, ms));

export async function demoAnalyze(text: string, more: boolean): Promise<Analysis> {
  await pause(600);
  if (more) {
    return {
      summary: "",
      model: "demo",
      choices: [
        {
          type: "extra",
          token: "Looks",
          sentence: "I like a {value} look.",
          question: "What look do you want?",
          kind: "multi",
          options: [
            { label: "Classic steel", emoji: "🪞", text: "classic brushed steel" },
            { label: "Retro", emoji: "📻", text: "retro" },
            { label: "Matte black", emoji: "🖤", text: "matte black" },
          ],
        },
      ],
    };
  }
  const all: Sent[] = [
    {
      type: "ask",
      span: "Should I get a grinder too?",
      statement: "I'd also like {value}.",
      question: "Get a grinder too?",
      kind: "single",
      explain: true,
      options: [
        { label: "Built-in grinder", emoji: "⚙️", text: "a machine with a built-in grinder" },
        { label: "Separate grinder", emoji: "🫘", text: "a separate burr grinder" },
        { label: "No grinder", emoji: "🚫", text: "to keep using pre-ground coffee" },
      ],
    },
    {
      type: "ask",
      span: "Which heating system should it have?",
      statement: "For heating, I'd like {value}.",
      question: "Which heating system?",
      kind: "single",
      explain: true,
      options: [
        { label: "Thermoblock", emoji: "⚡", text: "a thermoblock" },
        { label: "Single boiler", emoji: "🫖", text: "a single boiler" },
        { label: "Heat exchanger", emoji: "🔁", text: "a heat exchanger" },
        { label: "Dual boiler", emoji: "♨️", text: "a dual boiler" },
      ],
    },
    {
      type: "underline",
      span: "coffee machine",
      question: "What kind of machine?",
      kind: "single",
      explain: true,
      options: [
        { label: "Espresso", emoji: "☕", text: "espresso machine" },
        { label: "Bean-to-cup", emoji: "🫘", text: "bean-to-cup machine" },
        { label: "Pod", emoji: "💊", text: "pod machine" },
        { label: "Filter", emoji: "🫗", text: "filter coffee machine" },
      ],
    },
    {
      type: "underline",
      span: "small",
      question: "How small is the space?",
      kind: "slider",
      explain: true,
      slider: { stops: ["tiny", "small", "average-sized"], value: 1, minLabel: "tiny", maxLabel: "roomy" },
    },
    {
      type: "underline",
      span: "lattes",
      question: "Which drinks?",
      kind: "multi",
      options: [
        { label: "Lattes", emoji: "🥛", text: "lattes" },
        { label: "Cappuccinos", emoji: "☁️", text: "cappuccinos" },
        { label: "Espresso", emoji: "☕", text: "espresso" },
        { label: "Flat whites", emoji: "🤍", text: "flat whites" },
      ],
      current: ["Lattes"],
    },
    {
      type: "extra",
      token: "Budget",
      sentence: "My budget is {value}.",
      question: "What's your budget?",
      kind: "slider",
      slider: {
        min: 50,
        max: 1500,
        step: 50,
        value: 400,
        template: "up to €{value}",
        minLabel: "€50",
        maxLabel: "€1,500",
      },
    },
    {
      type: "extra",
      token: "Milk",
      sentence: "For milk I'd like {value}.",
      question: "How should it froth milk?",
      kind: "single",
      explain: true,
      options: [
        { label: "Automatic", emoji: "🤖", text: "automatic frothing" },
        { label: "Steam wand", emoji: "♨️", text: "a manual steam wand" },
        { label: "Separate frother", emoji: "🥄", text: "a separate frother" },
      ],
    },
    {
      type: "extra",
      token: "Counter space",
      sentence: "I have {value} of counter space.",
      question: "How much counter space?",
      kind: "single",
      options: [
        { label: "About 25 cm", emoji: "📏", text: "about 25 cm" },
        { label: "About 40 cm", emoji: "📐", text: "about 40 cm" },
        { label: "Plenty", emoji: "🧱", text: "plenty" },
      ],
    },
    {
      type: "extra",
      token: "Cups",
      sentence: "I drink about {value}.",
      question: "How many cups a day?",
      kind: "slider",
      slider: { min: 1, max: 8, step: 1, value: 2, template: "{value} cups a day" },
    },
  ];
  return {
    summary: "Let's pin down which coffee machine fits your kitchen and your lattes.",
    model: "demo",
    choices: all.filter(c => c.type === "extra" || text.includes(c.span)),
  };
}
export async function demoTidy(sentences: string[]): Reply<"/api/tidy"> {
  await pause(600);
  const must = /budget|need|must|small|kitchen|\bmy\b.*\bis\b/i,
    about = /\b(I'm|I am|I drink|I mostly|I'll probably|beginner)\b/i;
  const blocks: { heading: string; items: number[] }[] = [
    { heading: "", items: [0] },
    { heading: "Must-haves", items: [] },
    { heading: "Nice to have", items: [] },
  ];
  sentences.forEach((s, i) => {
    if (i) {
      blocks[about.test(s) ? 0 : must.test(s) ? 1 : 2]?.items.push(i);
    }
  });
  return { model: "demo", ms: 600, blocks };
}
export async function demoExplain(ch: Choice, opts: string[]): Promise<Explanation> {
  await pause(500);
  if (ch.question === "What kind of machine?") {
    return {
      intro: "This is the biggest fork: it decides how much effort each cup takes and how good the coffee can get.",
      options: [
        {
          label: "Espresso",
          what: "You grind, tamp and steam yourself. Best drinks, but it takes practice.",
          good_for: "hobbyists who enjoy the ritual",
          image: "espresso machine portafilter",
        },
        {
          label: "Bean-to-cup",
          what: "Grinds and brews at the push of a button. Convenient, pricier, bulkier.",
          good_for: "busy mornings, several drinkers",
          image: "bean to cup coffee machine",
        },
        {
          label: "Pod",
          what: "Cheap and tidy, but each cup costs more and the taste is limited.",
          good_for: "one quick cup a day",
          image: "coffee capsule machine",
        },
        {
          label: "Filter",
          what: "Brews a jug of milder coffee. No lattes without a separate frother.",
          good_for: "black coffee by the mug",
          image: "drip coffee maker",
        },
      ],
    };
  }
  if (ch.question === "Which heating system?") {
    return {
      intro: "The heating system decides how long you wait between pulling a shot and steaming milk.",
      options: [
        {
          label: "Thermoblock",
          what: "Heats water on demand. Ready in a minute, but steam is weak and shots vary.",
          good_for: "small budgets, the odd latte",
          image: "thermoblock espresso machine",
        },
        {
          label: "Single boiler",
          what: "One boiler for coffee and steam, so you wait while it switches temperature.",
          good_for: "mostly espresso, few milk drinks",
          image: "single boiler espresso machine",
        },
        {
          label: "Heat exchanger",
          what: "Brews and steams at once from one big boiler. Fast, needs a cooling flush.",
          good_for: "back-to-back milk drinks",
          image: "heat exchanger espresso machine",
        },
        {
          label: "Dual boiler",
          what: "Separate boilers for coffee and steam. Stable and fast, but big and pricey.",
          good_for: "daily lattes, enthusiasts",
          image: "dual boiler espresso machine",
        },
      ],
    };
  }
  if (ch.question === "How should it froth milk?") {
    return {
      intro:
        "Lattes need steamed milk. How the machine does it decides how much skill it takes and how silky the foam gets.",
      options: [
        {
          label: "Automatic",
          what: "Press a button and it froths for you. Easy, consistent, a bit more to clean.",
          good_for: "beginners and quick lattes",
        },
        {
          label: "Steam wand",
          what: "You steam the milk yourself. Silkiest foam once you learn, latte art possible.",
          good_for: "people who want café-style milk",
        },
        {
          label: "Separate frother",
          what: "A small jug that heats and whips milk on its own. Cheap, foam is airier.",
          good_for: "pod or filter machines",
        },
      ],
    };
  }
  return {
    intro: "This changes which machines fit you.",
    options: opts.map(l => ({ label: l, what: "A reasonable choice; it depends on your taste." })),
  };
}

export async function demoDecide(ch: Choice, { options, answers, asked }: DecideInput): Reply<"/api/decide"> {
  await pause(500);
  const machine = ch.question === "What kind of machine?";
  const heating = ch.question === "Which heating system?";
  const bank: { question: string; options: { label: string; emoji?: string; fav: string }[] }[] = heating
    ? [
        {
          question: "How many milk drinks in a row?",
          options: [
            { label: "Just one", emoji: "☕", fav: "Single boiler" },
            { label: "Two or three", emoji: "👫", fav: "Heat exchanger" },
            { label: "A whole round", emoji: "🎉", fav: "Dual boiler" },
          ],
        },
        {
          question: "How long can you wait for it to heat up?",
          options: [
            { label: "A minute", emoji: "⏱️", fav: "Thermoblock" },
            { label: "10 minutes", emoji: "⌛", fav: "Heat exchanger" },
            { label: "I'll put it on a timer", emoji: "⏰", fav: "Dual boiler" },
          ],
        },
        {
          question: "How much space can it take?",
          options: [
            { label: "As little as possible", emoji: "🤏", fav: "Thermoblock" },
            { label: "A normal machine", emoji: "📦", fav: "Heat exchanger" },
            { label: "Whatever it needs", emoji: "🏗️", fav: "Dual boiler" },
          ],
        },
      ]
    : machine
      ? [
          {
            question: "How often will you make milk drinks?",
            options: [
              { label: "Every day", emoji: "🥛", fav: "Espresso" },
              { label: "A few times a week", emoji: "📅", fav: "Bean-to-cup" },
              { label: "Rarely", emoji: "🫗", fav: "Filter" },
            ],
          },
          {
            question: "How much fiddling do you enjoy?",
            options: [
              { label: "Love the ritual", emoji: "🧪", fav: "Espresso" },
              { label: "Some is fine", emoji: "👌", fav: "Bean-to-cup" },
              { label: "One button please", emoji: "🔘", fav: "Pod" },
            ],
          },
          {
            question: "Rough budget?",
            options: [
              { label: "Under €150", emoji: "🪙", fav: "Pod" },
              { label: "€150–600", emoji: "💶", fav: "Espresso" },
              { label: "€600+", emoji: "💎", fav: "Bean-to-cup" },
            ],
          },
        ]
      : [
          {
            question: "How much time do you have in the morning?",
            options: options.map((l, i) => ({ label: ["Seconds", "A few minutes", "No rush"][i % 3] ?? "", fav: l })),
          },
          {
            question: "What matters most?",
            options: options.map((l, i) => ({ label: ["Ease", "Quality", "Price"][i % 3] ?? "", fav: l })),
          },
        ];
  const fresh = bank.filter(q => !asked.includes(q.question));
  if (!answers.length) {
    return { model: "demo", ms: 500, questions: fresh };
  }
  const votes: Record<string, number> = {};
  for (const a of answers) {
    const o = bank.find(q => q.question === a.q)?.options.find(x => x.label === a.a);
    if (o) {
      votes[o.fav] = (votes[o.fav] ?? 0) + 1;
    }
  }
  const best = Object.entries(votes).toSorted((a, b) => b[1] - a[1])[0]?.[0];
  return {
    model: "demo",
    ms: 500,
    questions: [],
    ...(best
      ? {
          recommendation: {
            label: best,
            why: `From what you said (${answers.map(a => a.a.toLowerCase()).join(", ")}), ${best.toLowerCase()} fits you best.`,
          },
        }
      : {}),
  };
}
