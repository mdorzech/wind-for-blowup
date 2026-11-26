// Wind Watch widget for the Scriptable app (iPhone Lock Screen and Home Screen).
// Paste this whole file into a new script in Scriptable. See README: "Lock Screen widget".
// It only reads the public dashboard data; it cannot switch anything.

const URL_BASE = "https://wind-watch.wind-watch.workers.dev";

async function load() {
  try {
    const req = new Request(`${URL_BASE}/status.json`);
    req.timeoutInterval = 15;
    return await req.loadJSON();
  } catch (e) {
    return null;
  }
}

const s = await load();
const family = config.widgetFamily || "accessoryRectangular";
const w = new ListWidget();
w.url = URL_BASE; // tapping the widget opens the dashboard
w.refreshAfterDate = new Date(Date.now() + 5 * 60 * 1000);

const round = (v) => (v === null || v === undefined ? "–" : String(Math.round(v)));
const plug = !s ? "?" : s.plug_on === true ? "ON" : s.plug_on === false ? "OFF" : "?";
const label = !s ? "No data" : { ok: "Calm", watch: "Watch", hold: "Held off", error: "Problem" }[s.level] || s.level;
const gust = s ? round(s.current_gust_mph) : "–";
const wind = s ? round(s.current_speed_mph) : "–";
const peak = s ? round(s.peak_gust_mph) : "–";

if (family === "accessoryInline") {
  // One line above the clock.
  w.addText(`💨 ${gust} mph · ${label} · ${plug}`);
} else if (family === "accessoryCircular") {
  w.addAccessoryWidgetBackground = true;
  const top = w.addText(gust);
  top.font = Font.boldSystemFont(18);
  top.centerAlignText();
  const bottom = w.addText(plug);
  bottom.font = Font.systemFont(10);
  bottom.centerAlignText();
} else if (family === "accessoryRectangular") {
  const title = w.addText(`💨 Wind Watch · ${label}`);
  title.font = Font.boldSystemFont(13);
  const line1 = w.addText(`Gusts ${gust} · wind ${wind} mph`);
  line1.font = Font.systemFont(12);
  const line2 = w.addText(`Peak ${peak} · plug ${plug}`);
  line2.font = Font.systemFont(12);
} else {
  // Home Screen sizes.
  const colors = { ok: "#1c7a4a", watch: "#9a5a00", hold: "#b34a12", error: "#b3261e" };
  w.backgroundColor = new Color("#0e151d");
  const title = w.addText("💨 Wind Watch");
  title.font = Font.boldSystemFont(14);
  title.textColor = Color.white();
  w.addSpacer(4);
  const state = w.addText(label);
  state.font = Font.boldSystemFont(20);
  state.textColor = new Color((s && colors[s.level]) || "#8a9bb0");
  w.addSpacer(4);
  for (const t of [`Gusts ${gust} mph`, `Wind ${wind} mph`, `Peak ${peak} mph`, `Plug ${plug}`]) {
    const line = w.addText(t);
    line.font = Font.systemFont(13);
    line.textColor = Color.white();
  }
}

if (config.runsInWidget) {
  Script.setWidget(w);
} else {
  await w.presentSmall();
}
Script.complete();
