import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

const launcherSource = readFileSync(
  fileURLToPath(new URL("../../native/windows-job-launcher/launcher.cpp", import.meta.url)),
  "utf8",
);

describe("Windows Job launcher source contract", () => {
  it("only advertises inherited standard handles when the complete set is valid", () => {
    expect(launcherSource).toContain("const bool has_complete_standard_handle_set =");
    expect(launcherSource).toContain("if (has_complete_standard_handle_set) {");
    expect(launcherSource).toContain("startup.StartupInfo.dwFlags |= STARTF_USESTDHANDLES;");
    expect(launcherSource).not.toContain(
      "startup.StartupInfo.dwFlags = STARTF_USESTDHANDLES | STARTF_USESHOWWINDOW;",
    );
  });

  it("requires protocol-v2 control and an explicit empty-Job drain acknowledgement", () => {
    expect(launcherSource).toContain('std::wstring_view(argv[2]) != L"2"');
    expect(launcherSource).toContain('std::wstring_view(argv[5]) != L"--control-file"');
    expect(launcherSource).toContain("ControlStopRequested(request.control_file)");
    expect(launcherSource).toContain("TerminateJobObject(job.get(), kControlledStopExitCode)");
    expect(launcherSource).toContain(
      "QueryInformationJobObject(job, JobObjectBasicAccountingInformation,",
    );
    expect(launcherSource).toContain("accounting.ActiveProcesses == 0");
    expect(launcherSource).toContain("JobObjectBasicProcessIdList");
    expect(launcherSource).toContain("WaitForSingleObject(tracked.handle.get(), remaining)");
    expect(launcherSource).toContain("tracked_processes.clear();");
    expect(launcherSource).toContain('constexpr char kDrainAcknowledgement[] = "drained\\n";');
    expect(launcherSource).toContain("MOVEFILE_WRITE_THROUGH");
  });

  it("does not bypass tracked process waits when Job accounting reaches zero", () => {
    const drainStart = launcherSource.indexOf("void WaitForEmptyJob(");
    const drainEnd = launcherSource.indexOf("void RemoveControlFileIfPresent", drainStart);
    const drainSource = launcherSource.slice(drainStart, drainEnd);

    expect(drainStart).toBeGreaterThan(0);
    expect(drainEnd).toBeGreaterThan(drainStart);
    expect(drainSource).toContain("if (accounting.ActiveProcesses == 0) {\n      break;");
    expect(drainSource).not.toContain("if (accounting.ActiveProcesses == 0) {\n      return;");
    expect(
      drainSource.indexOf("WaitForSingleObject(tracked.handle.get(), remaining)"),
    ).toBeGreaterThan(drainSource.indexOf("if (accounting.ActiveProcesses == 0)"));
    expect(drainSource.indexOf("tracked_processes.clear();")).toBeGreaterThan(
      drainSource.indexOf("WaitForSingleObject(tracked.handle.get(), remaining)"),
    );
  });

  it("publishes drain proof after cleanup and immediately before wrapper exit", () => {
    const assignment = launcherSource.indexOf("AssignProcessToJobObject(job.get(), process.get())");
    const finalDrain = launcherSource.lastIndexOf("WaitForEmptyJob(job.get(), tracked_processes);");
    const releaseProcess = launcherSource.lastIndexOf("process.reset();");
    const releaseJob = launcherSource.lastIndexOf("job.reset();");
    const removeControl = launcherSource.lastIndexOf(
      "RemoveControlFileIfPresent(request.control_file);",
    );
    const acknowledgement = launcherSource.lastIndexOf(
      "WriteDrainAcknowledgement(request.control_file);",
    );
    const wrapperExit = launcherSource.lastIndexOf("ExitProcess(child_exit_code);");

    expect(assignment).toBeGreaterThan(0);
    expect(finalDrain).toBeGreaterThan(assignment);
    expect(releaseProcess).toBeGreaterThan(finalDrain);
    expect(releaseJob).toBeGreaterThan(releaseProcess);
    expect(removeControl).toBeGreaterThan(releaseJob);
    expect(acknowledgement).toBeGreaterThan(removeControl);
    expect(wrapperExit).toBeGreaterThan(acknowledgement);
    expect(launcherSource.slice(assignment)).not.toContain("INFINITE");
  });
});
