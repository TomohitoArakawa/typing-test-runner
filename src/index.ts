import { chromium, type Browser, type Frame, type Page } from "playwright";

const TEST_URL = "https://www.e-typing.ne.jp/roma/variety/business.asp";
const COURSE_TITLE = "がんばれ新人君";
const MIN_SCORE = 270;
const MAX_SCORE = 300;
const MAX_ATTEMPTS = 5;
const DEFAULT_DELAY_MS = 200;
const MIN_DELAY_MS = 20;
const MAX_DELAY_MS = 260;

interface TestResult {
  score: number;
  level: string;
  inputTime: string;
  characters: number;
  mistakes: number;
  wpm: number;
  accuracy: string;
}

function getNumber(name: string, fallback: number): number {
  const value = Number(process.env[name]);
  return Number.isFinite(value) ? value : fallback;
}

function getTypingFrame(page: Page): Frame {
  const frame = page.frames().find((candidate) =>
    candidate.url().includes("/app/jsa_std/typing.asp"),
  );
  if (!frame) {
    throw new Error("Typing frame was not found.");
  }
  return frame;
}

async function waitForTypingFrame(page: Page): Promise<Frame> {
  await page.waitForFunction(
    () => [...document.querySelectorAll("iframe")].some((iframe) =>
      iframe.src.includes("/app/standard.asp"),
    ),
    { timeout: 10000 },
  );
  await page.waitForTimeout(250);
  for (let attempt = 0; attempt < 100; attempt += 1) {
    const frame = page.frames().find((candidate) =>
      candidate.url().includes("/app/jsa_std/typing.asp"),
    );
    if (frame) {
      return frame;
    }
    await page.waitForTimeout(100);
  }
  throw new Error("Typing frame did not load within 10 seconds.");
}

async function openCourse(page: Page): Promise<Frame> {
  await page.goto(TEST_URL, { waitUntil: "domcontentloaded" });
  await page.waitForSelector(`text=${COURSE_TITLE}`, { timeout: 30000 });
  await page.getByText(COURSE_TITLE, { exact: true }).click({ force: true });
  return waitForTypingFrame(page);
}

async function startTest(page: Page, frame: Frame): Promise<Frame> {
  let startFrame: Frame | undefined;
  for (let attempt = 0; attempt < 100 && !startFrame; attempt += 1) {
    for (const candidate of page.frames()) {
      if ((await candidate.getByText("スタート", { exact: true }).count()) > 0) {
        startFrame = candidate;
        break;
      }
    }
    if (!startFrame) {
      await page.waitForTimeout(100);
    }
  }
  if (!startFrame) {
    throw new Error("The start control was not found.");
  }
  await startFrame.getByText("スタート", { exact: true }).click();
  await page.waitForTimeout(3800);
  const typingFrame = getTypingFrame(page);
  await typingFrame.locator("#app").click();
  await page.keyboard.press("Space");
  for (let attempt = 0; attempt < 30; attempt += 1) {
    if (
      (await typingFrame.locator("#sentenceText").count()) > 0 &&
      (await typingFrame.locator("#sentenceText").innerText()).trim()
    ) {
      return typingFrame;
    }
    await page.waitForTimeout(100);
  }
  await typingFrame.locator("body").press("Space");
  await page.keyboard.press("Space");
  return typingFrame;
}

async function typeCurrentSentence(
  page: Page,
  frame: Frame,
  delayMs: number,
  shouldMakeMistake: boolean,
): Promise<void> {
  let sentence = "";
  for (let attempt = 0; attempt < 100 && !sentence; attempt += 1) {
    if ((await frame.locator("#sentenceText").count()) > 0) {
      sentence = (await frame.locator("#sentenceText").innerText()).trim();
    }
    if (!sentence) {
      await page.waitForTimeout(100);
    }
  }
  if (!sentence) {
    throw new Error("The current sentence is empty.");
  }

  await frame.locator("body").click();
  if (shouldMakeMistake) {
    await page.keyboard.press("X");
  }
  await page.keyboard.type(sentence, { delay: delayMs });
}

async function runSingleTest(
  page: Page,
  frame: Frame,
  delayMs: number,
  makeMistake: boolean,
): Promise<TestResult> {
  frame = await startTest(page, frame);
  for (let sentenceIndex = 0; sentenceIndex < 20; sentenceIndex += 1) {
    if ((await frame.locator("body").innerText()).includes("今回のタイピング結果")) {
      break;
    }

    await typeCurrentSentence(page, frame, delayMs, makeMistake && sentenceIndex === 0);
    await page.waitForTimeout(250);
  }

  await frame.waitForSelector("text=今回のタイピング結果", { timeout: 10000 });
  const text = await frame.locator("body").innerText();
  const result = parseResult(text);
  await frame.getByText("もう1回", { exact: true }).click().catch(() => undefined);
  return result;
}

function parseResult(text: string): TestResult {
  const lines = text.split("\n").map((line) => line.trim());
  const valueAfter = (label: string): string => {
    const index = lines.lastIndexOf(label);
    const value = index >= 0 ? lines[index + 1] : undefined;
    if (!value) {
      throw new Error(`Result field "${label}" was not found.`);
    }
    return value;
  };

  const score = Number(valueAfter("スコア"));
  const characters = Number(valueAfter("入力文字数"));
  const mistakes = Number(valueAfter("ミス入力数"));
  const wpm = Number(valueAfter("WPM"));
  if (![score, characters, mistakes, wpm].every(Number.isFinite)) {
    throw new Error("The typing result contains an invalid numeric value.");
  }

  return {
    score,
    level: valueAfter("レベル"),
    inputTime: valueAfter("入力時間"),
    characters,
    mistakes,
    wpm,
    accuracy: valueAfter("正確率"),
  };
}

function adjustDelay(score: number, delayMs: number): number {
  if (score < MIN_SCORE) {
    return Math.max(MIN_DELAY_MS, delayMs - Math.max(15, Math.round((MIN_SCORE - score) * 0.35)));
  }
  if (score > MAX_SCORE) {
    return Math.min(MAX_DELAY_MS, delayMs + Math.max(15, Math.round((score - MAX_SCORE) * 0.35)));
  }
  return delayMs;
}

function printResult(attempt: number, delayMs: number, result: TestResult): void {
  console.log(
    `Attempt ${attempt}: score=${result.score}, level=${result.level}, ` +
      `time=${result.inputTime}, chars=${result.characters}, mistakes=${result.mistakes}, ` +
      `wpm=${result.wpm}, accuracy=${result.accuracy}, delay=${delayMs}ms`,
  );
}

async function main(): Promise<void> {
  const browser: Browser = await chromium.launch({
    headless: process.env.HEADLESS === "true",
  });
  try {
    const page = await browser.newPage();
    let delayMs = getNumber("TYPE_DELAY_MS", DEFAULT_DELAY_MS);
    const maxAttempts = getNumber("MAX_ATTEMPTS", MAX_ATTEMPTS);
    const makeMistake = process.env.MAKE_MISTAKE !== "false";
    let frame = await openCourse(page);

    for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
      const result = await runSingleTest(page, frame, delayMs, makeMistake);
      printResult(attempt, delayMs, result);
      if (result.score >= MIN_SCORE && result.score <= MAX_SCORE) {
        console.log(`Target reached: ${MIN_SCORE}-${MAX_SCORE}.`);
        return;
      }

      delayMs = adjustDelay(result.score, delayMs);
      frame = getTypingFrame(page);
    }

    throw new Error(`Could not reach the target score range after ${maxAttempts} attempts.`);
  } finally {
    await browser.close();
  }
}

main().catch((error: unknown) => {
  console.error(error instanceof Error ? error.message : error);
  process.exitCode = 1;
});
