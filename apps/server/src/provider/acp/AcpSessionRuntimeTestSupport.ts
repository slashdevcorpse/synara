import { AcpSessionRuntime, type AcpSessionRuntimeOptions } from "./AcpSessionRuntime.ts";

export const makeAcpFixtureRuntimeLayer = (options: AcpSessionRuntimeOptions) =>
  AcpSessionRuntime.layer({ ...options, gracefulShutdownTimeout: "10 seconds" });
