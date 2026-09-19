import { mkdir } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import path from "node:path";
import puppeteer from "puppeteer-core";

const BASE = process.env.BASE || "http://127.0.0.1:5173/";
const OUT = fileURLToPath(new URL("../.verify", import.meta.url));
await mkdir(OUT, { recursive: true });
const shot = (name) => path.join(OUT, name);

const browser = await puppeteer.launch({
  executablePath: "/Applications/Comet.app/Contents/MacOS/Comet",
  headless: true,
  args: [
    "--no-sandbox",
    `--user-data-dir=/tmp/vtjanken-verify-${Date.now()}`,
  ],
});

const page = await browser.newPage();
await page.setViewport({ width: 1280, height: 800 });
await page.goto(BASE, { waitUntil: "load" });
await page.screenshot({ path: shot("01-home.png") });

const homeText = await page.evaluate(() => document.body.innerText);
if (!homeText.includes("現場猜拳")) throw new Error("home missing title");

await page.click("[data-act=create]");
await page.waitForSelector(".secret");
const controlUrl = page.url();
const room = controlUrl.split("/c/")[1];
if (!room) throw new Error("room not created");
await page.screenshot({ path: shot("02-control-empty.png") });

const stage = await browser.newPage();
await stage.setViewport({ width: 1600, height: 900 });
await stage.goto(`${BASE}#/s/${room}`, { waitUntil: "load" });
await new Promise((r) => setTimeout(r, 800));
await stage.screenshot({ path: shot("03-stage-idle.png") });

await page.bringToFront();
await page.keyboard.press("1");
await new Promise((r) => setTimeout(r, 600));
await page.screenshot({ path: shot("04-control-picked.png") });

const controlPick = await page.evaluate(() => document.body.innerText);
if (!controlPick.includes("石頭")) throw new Error("control did not show 石頭");

const stageBefore = await stage.evaluate(() => document.body.innerText);
if (stageBefore.includes("石頭")) {
  throw new Error("stage leaked 石頭 before reveal");
}
await stage.screenshot({ path: shot("05-stage-ready.png") });

await page.click("[data-act=reveal]");
await new Promise((r) => setTimeout(r, 1100));
await stage.screenshot({ path: shot("06-stage-count.png") });
const counting = await stage.evaluate(() => document.body.innerText);
if (counting.includes("石頭")) throw new Error("stage leaked 石頭 during countdown");
if (!/[321]/.test(counting)) throw new Error("countdown number missing");

await new Promise((r) => setTimeout(r, 3200));
await stage.screenshot({ path: shot("07-stage-reveal.png") });
const revealed = await stage.evaluate(() => document.body.innerText);
if (!revealed.includes("石頭")) throw new Error("stage did not reveal 石頭");

await page.screenshot({ path: shot("08-control-revealed.png") });
await page.setViewport({ width: 390, height: 844, isMobile: true });
await new Promise((r) => setTimeout(r, 300));
await page.screenshot({ path: shot("09-control-mobile.png") });

console.log("PASS room", room);
await browser.close();
