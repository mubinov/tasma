#!/usr/bin/env node
import { stderr } from "node:process";

// A daemon that exited 0 in silence would read as one that started.
stderr.write("tasma-daemon: not implemented\n");
process.exitCode = 1;
