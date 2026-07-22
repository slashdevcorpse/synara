import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

const launcherSource = readFileSync(
  fileURLToPath(new URL("../../native/windows-job-launcher/launcher.cpp", import.meta.url)),
  "utf8",
);
const launcherConfig = JSON.parse(
  readFileSync(
    fileURLToPath(
      new URL("../../native/windows-job-launcher/launcher.config.json", import.meta.url),
    ),
    "utf8",
  ),
) as { readonly protocolVersion: string };

describe("Windows Job launcher source contract", () => {
  it("only advertises inherited standard handles when the complete set is valid", () => {
    expect(launcherSource).toContain("const bool has_complete_standard_handle_set =");
    expect(launcherSource).toContain("if (has_complete_standard_handle_set) {");
    expect(launcherSource).toContain("startup.StartupInfo.dwFlags |= STARTF_USESTDHANDLES;");
    expect(launcherSource).not.toContain(
      "startup.StartupInfo.dwFlags = STARTF_USESTDHANDLES | STARTF_USESHOWWINDOW;",
    );
  });

  it("requires protocol v2 for Job-empty completion proof", () => {
    expect(launcherConfig.protocolVersion).toBe("2");
    expect(launcherSource).toContain('std::wstring_view(argv[2]) != L"2"');
    expect(launcherSource).toContain("--completion-receipt <absolute-path>");
    expect(launcherSource).toContain("--receipt-token <token>");
    expect(launcherSource).not.toContain('std::wstring_view(argv[2]) != L"1"');
  });

  it("associates the completion port before assigning or resuming the target", () => {
    const completionPortIndex = launcherSource.indexOf("CreateIoCompletionPort");
    const associationIndex = launcherSource.indexOf("JobObjectAssociateCompletionPortInformation");
    const assignmentIndex = launcherSource.indexOf("AssignProcessToJobObject");
    const resumeIndex = launcherSource.indexOf("ResumeThread");

    expect(completionPortIndex).toBeGreaterThan(-1);
    expect(associationIndex).toBeGreaterThan(completionPortIndex);
    expect(assignmentIndex).toBeGreaterThan(associationIndex);
    expect(resumeIndex).toBeGreaterThan(assignmentIndex);
  });

  it("drains completion notifications in bounded batches throughout the root lifetime", () => {
    const readStart = launcherSource.indexOf(
      "[[nodiscard]] CompletionPortReadResult ReadJobCompletionOrExitUnproven(",
    );
    const liveDrainStart = launcherSource.indexOf(
      "[[nodiscard]] bool DrainLiveJobCompletionBatchOrExitUnproven(",
      readStart,
    );
    const rootWaitStart = launcherSource.indexOf(
      "[[nodiscard]] DWORD WaitForRootProcessOrTerminationWhileDrainingJobCompletions(",
      liveDrainStart,
    );
    const finalWaitStart = launcherSource.indexOf(
      "void WaitForJobEmptyOrExitUnproven(",
      rootWaitStart,
    );
    const readSource = launcherSource.slice(readStart, liveDrainStart);
    const liveDrainSource = launcherSource.slice(liveDrainStart, rootWaitStart);
    const rootWaitSource = launcherSource.slice(rootWaitStart, finalWaitStart);

    expect(readSource).toContain("GetQueuedCompletionStatus(");
    expect(readSource).toContain("completion key did not match the Job");
    expect(liveDrainSource).toContain("index < kLiveCompletionDrainBatchSize");
    expect(liveDrainSource).toContain('job, completion_port, 0, L"drain-live-completion-port"');
    expect(liveDrainSource).toContain("Discard them here");
    expect(rootWaitSource).toContain("WaitForMultipleObjects(");
    expect(rootWaitSource).toContain("wait_handles{process, termination_event}");
    expect(rootWaitSource).toContain(
      "DrainLiveJobCompletionBatchOrExitUnproven(job, completion_port)",
    );
    expect(rootWaitSource).toContain("batch_saturated ? 0 : kRootProcessPollIntervalMilliseconds");

    const wmainStart = launcherSource.indexOf("int wmain(");
    const liveWaitCall = launcherSource.indexOf(
      "WaitForRootProcessOrTerminationWhileDrainingJobCompletions(",
      wmainStart,
    );
    const finalWaitCall = launcherSource.lastIndexOf(
      "WaitForJobEmptyOrExitUnproven(job.get(), completion_port.get(),",
    );
    expect(liveWaitCall).toBeGreaterThan(wmainStart);
    expect(finalWaitCall).toBeGreaterThan(liveWaitCall);
    expect(launcherSource).not.toContain("WaitForSingleObject(process.get(), INFINITE)");
  });

  it("cannot publish completion until ACTIVE_PROCESS_ZERO is independently verified", () => {
    expect(launcherSource).toContain("JOB_OBJECT_MSG_ACTIVE_PROCESS_ZERO");
    expect(launcherSource).toContain("JobObjectBasicAccountingInformation");
    expect(launcherSource).toContain("accounting.ActiveProcesses == 0");
    expect(launcherSource).toContain("kUnprovenJobExitCode = 249");
    expect(launcherSource).toContain("ExitWithUnprovenJobFailure");
    expect(launcherSource).not.toContain("Sleep(INFINITE)");

    const waitIndex = launcherSource.lastIndexOf(
      "WaitForJobEmptyOrExitUnproven(job.get(), completion_port.get(),",
    );
    const receiptIndex = launcherSource.lastIndexOf("WriteCompletionReceiptOrExit(request);");
    const exitIndex = launcherSource.lastIndexOf("ExitProcess(child_exit_code);");
    expect(waitIndex).toBeGreaterThan(-1);
    expect(receiptIndex).toBeGreaterThan(waitIndex);
    expect(exitIndex).toBeGreaterThan(receiptIndex);
  });

  it("queries before termination and polls accounting when Job notifications are delayed", () => {
    const waitStart = launcherSource.indexOf("void WaitForJobEmptyOrExitUnproven(");
    const waitEnd = launcherSource.indexOf("void WriteCompletionReceiptOrExit", waitStart);
    const waitSource = launcherSource.slice(waitStart, waitEnd);
    const initialQueryIndex = waitSource.indexOf("QueryJobEmpty(job, empty, query_error)");
    const terminateIndex = waitSource.indexOf("TerminateJobObject(job, termination_exit_code)");

    expect(waitStart).toBeGreaterThan(-1);
    expect(waitEnd).toBeGreaterThan(waitStart);
    expect(initialQueryIndex).toBeGreaterThan(-1);
    expect(terminateIndex).toBeGreaterThan(initialQueryIndex);
    expect(waitSource).toContain("kJobEmptyPollIntervalMilliseconds");
    expect(waitSource).toContain("GetTickCount64() - wait_started_at");
    expect(waitSource).toContain("elapsed >= kJobEmptyDeadlineMilliseconds");
    expect(waitSource).toContain("CompletionPortReadResult::kTimedOut");
    expect(waitSource).not.toContain("INFINITE");
  });

  it("keeps polling when a nested or stale zero-process message contradicts outer accounting", () => {
    const waitStart = launcherSource.indexOf("void WaitForJobEmptyOrExitUnproven(");
    const waitEnd = launcherSource.indexOf("void WriteCompletionReceiptOrExit", waitStart);
    const waitSource = launcherSource.slice(waitStart, waitEnd);
    const zeroMessageIndex = waitSource.indexOf(
      "completion_code != JOB_OBJECT_MSG_ACTIVE_PROCESS_ZERO",
    );
    const verifiedMessageSource = waitSource.slice(zeroMessageIndex);

    expect(zeroMessageIndex).toBeGreaterThan(-1);
    expect(verifiedMessageSource).toMatch(/if \(!empty\) \{[\s\S]*?continue;\s*\}\s*return;/u);
    expect(verifiedMessageSource).toContain("Nested Jobs forward completion messages");
    expect(launcherSource).not.toContain(
      "ACTIVE_PROCESS_ZERO arrived while ActiveProcesses was nonzero",
    );
  });

  it("creates and flushes a nonce-and-launcher-pid receipt only after the Job proof", () => {
    expect(launcherSource).toContain("CREATE_NEW");
    expect(launcherSource).toContain("WriteFile(receipt_file.get()");
    expect(launcherSource).toContain("FlushFileBuffers(receipt_file.get())");
    expect(launcherSource).toContain("if (request.completion_receipt_path.empty())");
    expect(launcherSource).toContain("std::to_string(GetCurrentProcessId())");
    expect(launcherSource).toContain("receipt.append(launcher_pid)");
  });

  it("writes receipts for proven no-tree and assigned-failure exits but never for unproven exits", () => {
    const noTreeStart = launcherSource.indexOf("[[noreturn]] void ExitWithNoAssignedTreeFailure(");
    const assignedStart = launcherSource.indexOf(
      "[[noreturn]] void ExitAssignedFailure(",
      noTreeStart,
    );
    const terminateStart = launcherSource.indexOf(
      "[[noreturn]] void SignalTerminationEventOrExit(",
      assignedStart,
    );
    const noTreeSource = launcherSource.slice(noTreeStart, assignedStart);
    const assignedSource = launcherSource.slice(assignedStart, terminateStart);
    const unprovenStart = launcherSource.indexOf("[[noreturn]] void ExitWithUnprovenJobFailure(");
    const unprovenEnd = launcherSource.indexOf("[[noreturn]] void ExitUsage", unprovenStart);
    const unprovenSource = launcherSource.slice(unprovenStart, unprovenEnd);

    expect(noTreeStart).toBeGreaterThan(-1);
    expect(assignedStart).toBeGreaterThan(noTreeStart);
    expect(noTreeSource.indexOf("WriteCompletionReceiptOrExit(request);")).toBeLessThan(
      noTreeSource.indexOf("ExitWithFailure(exit_code"),
    );
    expect(assignedSource.indexOf("WaitForJobEmptyOrExitUnproven(")).toBeLessThan(
      assignedSource.indexOf("WriteCompletionReceiptOrExit(request);"),
    );
    expect(assignedSource.indexOf("WriteCompletionReceiptOrExit(request);")).toBeLessThan(
      assignedSource.indexOf("ExitWithFailure(exit_code"),
    );
    expect(unprovenSource).not.toContain("WriteCompletionReceiptOrExit");

    const wmainStart = launcherSource.indexOf("int wmain(");
    const assignmentIndex = launcherSource.indexOf("AssignProcessToJobObject", wmainStart);
    const beforeAssignment = launcherSource.slice(wmainStart, assignmentIndex);
    expect(beforeAssignment).toContain("GetFileAttributesW(request.target.c_str())");
    expect(beforeAssignment).toContain("ExitWithNoAssignedTreeFailure(");
    expect(beforeAssignment).not.toContain("ExitWithFailure(");
  });

  it("uses an exact owner event and never lets the controller open or terminate a Job", () => {
    const parseStart = launcherSource.indexOf("[[nodiscard]] LaunchRequest ParseRequest(");
    const parseEnd = launcherSource.indexOf(
      "[[nodiscard]] std::wstring BuildCommandLine",
      parseStart,
    );
    const parseSource = launcherSource.slice(parseStart, parseEnd);
    const jobNameIndex = parseSource.indexOf('L"--job-name"');
    const terminationEventIndex = parseSource.indexOf('L"--termination-event"');
    const receiptIndex = parseSource.indexOf('L"--completion-receipt"');
    expect(jobNameIndex).toBeGreaterThan(-1);
    expect(terminationEventIndex).toBeGreaterThan(jobNameIndex);
    expect(receiptIndex).toBeGreaterThan(terminationEventIndex);

    expect(launcherSource).toContain("request.job_name.empty() ? nullptr");
    expect(launcherSource).toContain("create_job_error == ERROR_ALREADY_EXISTS");
    expect(launcherSource).toContain("refusing to reuse an existing named Job");
    expect(launcherSource).toContain("CreateEventW(nullptr, FALSE, FALSE");
    expect(launcherSource).toContain("refusing to reuse an existing termination event");
    expect(launcherSource).toContain("wait_result == WAIT_OBJECT_0 + 1");

    const terminateStart = launcherSource.indexOf(
      "[[noreturn]] void SignalTerminationEventOrExit(",
    );
    const terminateEnd = launcherSource.indexOf("}  // namespace", terminateStart);
    const terminateSource = launcherSource.slice(terminateStart, terminateEnd);
    expect(terminateSource).toContain("OpenProcess(SYNCHRONIZE");
    expect(terminateSource).toContain("OpenEventW(");
    expect(terminateSource).toContain("EVENT_MODIFY_STATE");
    expect(terminateSource).toContain("SetEvent(termination_event.get())");
    expect(terminateSource).toContain("open_error != ERROR_FILE_NOT_FOUND");
    expect(terminateSource).toContain("kOpenTerminationEventPollIntervalMilliseconds");
    expect(terminateSource).toContain("elapsed >= kJobEmptyDeadlineMilliseconds");
    expect(terminateSource).toContain("launcher_wait == WAIT_OBJECT_0");
    expect(terminateSource).not.toContain("OpenJobObjectW");
    expect(terminateSource).not.toContain("TerminateJobObject");
    expect(terminateSource).not.toContain("INFINITE");
  });
});
