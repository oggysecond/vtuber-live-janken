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
  args: ["--no-sandbox", `--user-data-dir=/tmp/vtjanken-help-${Date.now()}`],
});

const page = await browser.newPage();
await page.setViewport({ width: 1280, height: 900 });
await page.goto(BASE, { waitUntil: "load" });
const home = await page.evaluate(() => document.body.innerText);
if (!home.includes("工作人員說明")) throw new Error("home missing staff button");
await page.screenshot({ path: shot("10-home-help-buttons.png") });

await page.click("[data-act=help]");
await page.waitForSelector(".help-card");
const help = await page.evaluate(() => document.body.innerText);
if (!help.includes("30 秒上手")) throw new Error("help missing 30 秒上手");
if (!help.includes("工作人員手冊")) throw new Error("help missing staff handbook");
await page.screenshot({ path: shot("11-help.png") });

await page.click("a[href='#/help/staff']");
await new Promise((r) => setTimeout(r, 400));
const staff = await page.evaluate(() => document.body.innerText);
if (!staff.includes("開場前 15 分鐘")) throw new Error("staff section missing");
if (!staff.includes("出事怎麼辦")) throw new Error("staff troubleshooting missing");
await page.screenshot({ path: shot("12-staff.png") });

await page.setViewport({ width: 390, height: 844, isMobile: true });
await page.goto(`${BASE}#/help/staff`, { waitUntil: "load" });
await page.waitForSelector("#staff");
await new Promise((r) => setTimeout(r, 300));
await page.screenshot({ path: shot("13-staff-mobile.png") });

console.log("HELP PASS");
await browser.close();
