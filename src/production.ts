// jcoder — a coding agent for a local LLM server
// Copyright (C) 2026 Jason Roughley
// SPDX-License-Identifier: GPL-3.0-or-later
//
// This program is free software: you can redistribute it and/or modify it
// under the terms of the GNU General Public License as published by the Free
// Software Foundation, either version 3 of the License, or (at your option)
// any later version. It is distributed WITHOUT ANY WARRANTY; see the LICENSE
// file for details.

/**
 * React's development build records a performance.measure for every render
 * and Node keeps them all: a spinner left ticking at a question ran the heap
 * out in a few hours. React picks its build from NODE_ENV as it loads, so
 * index.ts imports this first; it puts the user's value back once everything
 * is loaded, so the commands we run don't inherit ours.
 */
export const userNodeEnv = process.env.NODE_ENV;
process.env.NODE_ENV = "production";

export function restoreNodeEnv(): void {
  if (userNodeEnv === undefined) delete process.env.NODE_ENV;
  else process.env.NODE_ENV = userNodeEnv;
}
