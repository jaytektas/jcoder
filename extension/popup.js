// jcoder in Chrome — Copyright (C) 2026 Jason Roughley — SPDX-License-Identifier: GPL-3.0-or-later
const $ = (id) => document.getElementById(id);

function show(status) {
  const box = $("sessions");
  box.replaceChildren();
  if (!status.sessions.length) {
    const e = document.createElement("span");
    e.className = "empty";
    e.textContent = "No jcoder found. Start jcoder with /browser on.";
    box.append(e);
    return;
  }
  for (const s of status.sessions) {
    const row = document.createElement("div");
    row.className = "session";
    const dot = document.createElement("span");
    dot.className = "dot";
    const name = document.createElement("span");
    name.textContent = s.name;
    const url = document.createElement("span");
    url.className = "url";
    url.textContent = s.url.replace(/^ws:\/\//, "");
    row.append(dot, name, url);
    box.append(row);
  }
}

async function refresh(first) {
  const status = await chrome.runtime.sendMessage({ type: "status" });
  if (first) {
    $("addresses").value = status.settings.addresses;
    $("token").value = status.settings.token;
  }
  show(status);
}

$("form").addEventListener("submit", async (e) => {
  e.preventDefault();
  await chrome.storage.local.set({ addresses: $("addresses").value.trim() || "127.0.0.1:47823-47832", token: $("token").value.trim() });
  $("saved").textContent = "Saved";
  setTimeout(() => refresh(false), 1500);
});

refresh(true);
// New connections show up as they're made.
setInterval(() => refresh(false), 1000);
