// jcoder — a coding agent for a local LLM server
// Copyright (C) 2026 Jason Roughley
// SPDX-License-Identifier: GPL-3.0-or-later
//
// This program is free software: you can redistribute it and/or modify it
// under the terms of the GNU General Public License as published by the Free
// Software Foundation, either version 3 of the License, or (at your option)
// any later version. It is distributed WITHOUT ANY WARRANTY; see the LICENSE
// file for details.

import { spawn } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { HOME } from "./config.js";
import { duration } from "./ui.js";

interface Job {
  id: string;
  command: string;
  pid: number;
  log: string;
  /** Bytes of the log the model has already been given. */
  read: number;
  exit?: string;
  started: number;
}

const DIR = path.join(HOME, "jobs");

/**
 * Background commands. Output goes to a log file rather than a pipe, so a
 * chatty server can't block anything, and new output is read by offset.
 * Everything still running is stopped when jcoder exits.
 */
export class Jobs {
  private jobs = new Map<string, Job>();
  private n = 0;

  constructor() {
    process.on("exit", () => this.stopAll());
  }

  start(command: string, cwd: string): Job {
    fs.mkdirSync(DIR, { recursive: true });
    const id = `job${++this.n}`;
    const log = path.join(DIR, `${process.pid}-${id}.log`);
    const fd = fs.openSync(log, "w");
    const child = spawn("bash", ["-c", command], {
      cwd,
      detached: true,
      stdio: ["ignore", fd, fd],
      env: { ...process.env, PAGER: "cat", GIT_PAGER: "cat", TERM: "dumb" },
    });
    fs.closeSync(fd);
    const job: Job = { id, command, pid: child.pid!, log, read: 0, started: Date.now() };
    child.on("exit", (code, signal) => (job.exit = signal ? `killed by ${signal}` : `exit ${code}`));
    child.on("error", (e) => (job.exit = `failed: ${e.message}`));
    this.jobs.set(id, job);
    return job;
  }

  get(id: string): Job | undefined {
    return this.jobs.get(id);
  }

  list(): Job[] {
    return [...this.jobs.values()];
  }

  /** New output since the last read, waiting up to `waitMs` for some to appear or the job to end. */
  async output(id: string, waitMs: number, signal: AbortSignal): Promise<{ text: string; status: string } | null> {
    const job = this.jobs.get(id);
    if (!job) return null;
    const size = () => {
      try {
        return fs.statSync(job.log).size;
      } catch {
        return 0;
      }
    };
    const until = Date.now() + waitMs;
    while (Date.now() < until && size() === job.read && !job.exit && !signal.aborted)
      await new Promise((r) => setTimeout(r, 200));
    const end = size();
    let text = "";
    if (end > job.read) {
      const fd = fs.openSync(job.log, "r");
      const buf = Buffer.alloc(end - job.read);
      fs.readSync(fd, buf, 0, buf.length, job.read);
      fs.closeSync(fd);
      text = buf.toString("utf8");
      job.read = end;
    }
    return { text, status: this.status(job) };
  }

  status(job: Job): string {
    const secs = Math.round((Date.now() - job.started) / 1000);
    return job.exit ? `${job.exit} after ${duration(secs)}` : `running for ${duration(secs)}`;
  }

  stop(id: string): boolean {
    const job = this.jobs.get(id);
    if (!job) return false;
    if (!job.exit) {
      try {
        process.kill(-job.pid, "SIGTERM");
      } catch {}
      setTimeout(() => {
        try {
          if (!job.exit) process.kill(-job.pid, "SIGKILL");
        } catch {}
      }, 2000).unref();
    }
    return true;
  }

  stopAll(): void {
    for (const j of this.jobs.values()) {
      if (j.exit) continue;
      try {
        process.kill(-j.pid, "SIGKILL");
      } catch {}
    }
  }
}
