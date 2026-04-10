#!/usr/bin/env node
import "dotenv/config";
import process from "node:process";
import { startSupervisorBroker } from "../src/cli/supervisorBroker.js";

startSupervisorBroker().catch((error) => {
  console.error("Failed to start oracle supervisor broker:", error);
  process.exitCode = 1;
});
