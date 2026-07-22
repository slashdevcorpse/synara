// FILE: launcher.cpp
// Purpose: Starts one Windows provider tree inside an atomic kill-on-close Job Object.
// Layer: Server native process supervision helper
// Protocol: synara-windows-job-launcher --protocol 2 --argument-mode argv|verbatim
//           [--job-name <name> --termination-event <name>
//            --completion-receipt <absolute-path> --receipt-token <token>]
//           -- <target> [args...]

#define WIN32_LEAN_AND_MEAN
#define NOMINMAX
#include <windows.h>

#include <array>
#include <cstdint>
#include <cstdio>
#include <cwchar>
#include <string>
#include <string_view>
#include <vector>

namespace {

constexpr DWORD kUsageExitCode = 240;
constexpr DWORD kTargetExitCode = 241;
constexpr DWORD kJobExitCode = 242;
constexpr DWORD kHandleExitCode = 243;
constexpr DWORD kCreateProcessExitCode = 244;
constexpr DWORD kAssignProcessExitCode = 245;
constexpr DWORD kResumeProcessExitCode = 246;
constexpr DWORD kWaitProcessExitCode = 247;
constexpr DWORD kReceiptExitCode = 248;
constexpr DWORD kUnprovenJobExitCode = 249;
constexpr DWORD kOpenTerminationEventExitCode = 250;
constexpr DWORD kSignalTerminationEventExitCode = 251;
constexpr DWORD kOpenTerminationEventPollIntervalMilliseconds = 50;
constexpr DWORD kRootProcessPollIntervalMilliseconds = 200;
constexpr DWORD kJobEmptyPollIntervalMilliseconds = 200;
constexpr ULONGLONG kJobEmptyDeadlineMilliseconds = 30'000;
constexpr std::size_t kMaximumKernelObjectNameLength = 128;
constexpr std::size_t kLiveCompletionDrainBatchSize = 256;

class OwnedHandle final {
 public:
  OwnedHandle() = default;
  explicit OwnedHandle(HANDLE value) : value_(value) {}
  OwnedHandle(const OwnedHandle&) = delete;
  OwnedHandle& operator=(const OwnedHandle&) = delete;
  OwnedHandle(OwnedHandle&& other) noexcept : value_(other.release()) {}
  OwnedHandle& operator=(OwnedHandle&& other) noexcept {
    if (this != &other) {
      reset(other.release());
    }
    return *this;
  }
  ~OwnedHandle() { reset(); }

  [[nodiscard]] HANDLE get() const { return value_; }
  [[nodiscard]] explicit operator bool() const {
    return value_ != nullptr && value_ != INVALID_HANDLE_VALUE;
  }
  [[nodiscard]] HANDLE release() {
    const HANDLE value = value_;
    value_ = nullptr;
    return value;
  }
  void reset(HANDLE value = nullptr) {
    if (*this) {
      CloseHandle(value_);
    }
    value_ = value;
  }

 private:
  HANDLE value_ = nullptr;
};

class AttributeList final {
 public:
  AttributeList() = default;
  AttributeList(const AttributeList&) = delete;
  AttributeList& operator=(const AttributeList&) = delete;
  ~AttributeList() {
    if (list_ != nullptr) {
      DeleteProcThreadAttributeList(list_);
    }
    if (storage_ != nullptr) {
      HeapFree(GetProcessHeap(), 0, storage_);
    }
  }

  [[nodiscard]] bool initialize() {
    SIZE_T bytes = 0;
    InitializeProcThreadAttributeList(nullptr, 1, 0, &bytes);
    if (bytes == 0 || GetLastError() != ERROR_INSUFFICIENT_BUFFER) {
      return false;
    }
    storage_ = HeapAlloc(GetProcessHeap(), HEAP_ZERO_MEMORY, bytes);
    if (storage_ == nullptr) {
      SetLastError(ERROR_NOT_ENOUGH_MEMORY);
      return false;
    }
    list_ = reinterpret_cast<LPPROC_THREAD_ATTRIBUTE_LIST>(storage_);
    return InitializeProcThreadAttributeList(list_, 1, 0, &bytes) != FALSE;
  }

  [[nodiscard]] LPPROC_THREAD_ATTRIBUTE_LIST get() const { return list_; }

 private:
  void* storage_ = nullptr;
  LPPROC_THREAD_ATTRIBUTE_LIST list_ = nullptr;
};

void ReportFailure(std::wstring_view stage,
                   DWORD error_code,
                   std::wstring_view detail = {}) {
  wchar_t* system_message = nullptr;
  const DWORD message_length = FormatMessageW(
      FORMAT_MESSAGE_ALLOCATE_BUFFER | FORMAT_MESSAGE_FROM_SYSTEM |
          FORMAT_MESSAGE_IGNORE_INSERTS,
      nullptr, error_code, MAKELANGID(LANG_NEUTRAL, SUBLANG_DEFAULT),
      reinterpret_cast<wchar_t*>(&system_message), 0, nullptr);

  std::fwprintf(stderr,
                L"[synara-windows-job-launcher] stage=%.*ls win32_error=%lu",
                static_cast<int>(stage.size()), stage.data(),
                static_cast<unsigned long>(error_code));
  if (!detail.empty()) {
    std::fwprintf(stderr, L" detail=%.*ls", static_cast<int>(detail.size()),
                  detail.data());
  }
  if (message_length > 0 && system_message != nullptr) {
    while (message_length > 0 &&
           (system_message[message_length - 1] == L'\r' ||
            system_message[message_length - 1] == L'\n')) {
      system_message[message_length - 1] = L'\0';
    }
    std::fwprintf(stderr, L" message=%ls", system_message);
  }
  std::fwprintf(stderr, L"\n");
  std::fflush(stderr);
  if (system_message != nullptr) {
    LocalFree(system_message);
  }
}

[[noreturn]] void ExitWithFailure(DWORD exit_code,
                                  std::wstring_view stage,
                                  DWORD error_code,
                                  std::wstring_view detail = {}) {
  ReportFailure(stage, error_code, detail);
  ExitProcess(exit_code);
}

[[noreturn]] void ExitWithUnprovenJobFailure(
    std::wstring_view stage,
    DWORD error_code,
    std::wstring_view detail = {}) {
  // The absence of a completion receipt tells the parent this exit is not
  // process-tree proof. Exiting also closes the Job handle so Windows keeps
  // enforcing kill-on-close without leaving a permanently hung helper.
  ExitWithFailure(kUnprovenJobExitCode, stage, error_code, detail);
}

[[noreturn]] void ExitUsage(std::wstring_view detail) {
  ExitWithFailure(kUsageExitCode, L"protocol", ERROR_INVALID_PARAMETER, detail);
}

[[nodiscard]] bool IsAbsoluteWindowsPath(std::wstring_view path) {
  if (path.size() >= 3 &&
      ((path[0] >= L'A' && path[0] <= L'Z') ||
       (path[0] >= L'a' && path[0] <= L'z')) &&
      path[1] == L':' && (path[2] == L'\\' || path[2] == L'/')) {
    return true;
  }
  return path.size() >= 2 &&
         ((path[0] == L'\\' && path[1] == L'\\') ||
          (path[0] == L'/' && path[1] == L'/'));
}

[[nodiscard]] bool ContainsLineBreak(std::wstring_view value) {
  return value.find_first_of(L"\r\n") != std::wstring_view::npos;
}

[[nodiscard]] bool IsNonEmptyAsciiToken(std::wstring_view value) {
  if (value.empty()) {
    return false;
  }
  for (const wchar_t character : value) {
    if (character < L'!' || character > L'~') {
      return false;
    }
  }
  return true;
}

[[nodiscard]] bool IsValidKernelObjectName(std::wstring_view value) {
  if (value.empty() || value.size() > kMaximumKernelObjectNameLength) {
    return false;
  }
  for (const wchar_t character : value) {
    const bool is_ascii_letter =
        (character >= L'A' && character <= L'Z') ||
        (character >= L'a' && character <= L'z');
    const bool is_ascii_digit = character >= L'0' && character <= L'9';
    if (!is_ascii_letter && !is_ascii_digit && character != L'-' &&
        character != L'_' && character != L'.') {
      return false;
    }
  }
  return true;
}

[[nodiscard]] bool ParseProcessId(std::wstring_view value,
                                  DWORD& process_id) {
  if (value.empty()) {
    return false;
  }
  std::uint64_t parsed = 0;
  for (const wchar_t character : value) {
    if (character < L'0' || character > L'9') {
      return false;
    }
    const std::uint64_t digit =
        static_cast<std::uint64_t>(character - L'0');
    if (parsed > (static_cast<std::uint64_t>(MAXDWORD) - digit) / 10) {
      return false;
    }
    parsed = parsed * 10 + digit;
  }
  if (parsed == 0) {
    return false;
  }
  process_id = static_cast<DWORD>(parsed);
  return true;
}

void AppendQuotedWindowsArgument(std::wstring_view argument,
                                 std::wstring& command_line) {
  if (argument.empty()) {
    command_line.append(L"\"\"");
    return;
  }

  const bool needs_quotes =
      argument.find_first_of(L" \t\"") != std::wstring_view::npos;
  if (!needs_quotes) {
    command_line.append(argument);
    return;
  }

  command_line.push_back(L'\"');
  std::size_t backslashes = 0;
  for (const wchar_t character : argument) {
    if (character == L'\\') {
      ++backslashes;
      continue;
    }
    if (character == L'\"') {
      command_line.append(backslashes * 2 + 1, L'\\');
      command_line.push_back(L'\"');
      backslashes = 0;
      continue;
    }
    command_line.append(backslashes, L'\\');
    backslashes = 0;
    command_line.push_back(character);
  }
  command_line.append(backslashes * 2, L'\\');
  command_line.push_back(L'\"');
}

enum class ArgumentMode { kArgv, kVerbatim };

struct LaunchRequest {
  ArgumentMode argument_mode;
  std::wstring target;
  std::vector<std::wstring> arguments;
  std::wstring job_name;
  std::wstring termination_event_name;
  std::wstring completion_receipt_path;
  std::wstring receipt_token;
};

[[nodiscard]] LaunchRequest ParseRequest(int argc, wchar_t* argv[]) {
  if (argc < 7 || std::wstring_view(argv[1]) != L"--protocol" ||
      std::wstring_view(argv[2]) != L"2" ||
      std::wstring_view(argv[3]) != L"--argument-mode") {
    ExitUsage(
        L"expected --protocol 2 --argument-mode argv|verbatim "
        L"[--job-name <name>] "
        L"[--termination-event <name>] "
        L"[--completion-receipt <absolute-path> --receipt-token <token>] "
        L"-- <target> [args...]");
  }

  const std::wstring_view mode_value(argv[4]);
  ArgumentMode argument_mode;
  if (mode_value == L"argv") {
    argument_mode = ArgumentMode::kArgv;
  } else if (mode_value == L"verbatim") {
    argument_mode = ArgumentMode::kVerbatim;
  } else {
    ExitUsage(L"argument mode must be argv or verbatim");
  }

  int next_index = 5;
  std::wstring job_name;
  if (next_index < argc &&
      std::wstring_view(argv[next_index]) == L"--job-name") {
    if (next_index + 1 >= argc ||
        !IsValidKernelObjectName(argv[next_index + 1])) {
      ExitUsage(
          L"job name must be 1-128 ASCII letters, digits, '.', '_', or '-'");
    }
    job_name = argv[next_index + 1];
    next_index += 2;
  }

  std::wstring termination_event_name;
  if (next_index < argc &&
      std::wstring_view(argv[next_index]) == L"--termination-event") {
    if (next_index + 1 >= argc ||
        !IsValidKernelObjectName(argv[next_index + 1])) {
      ExitUsage(
          L"termination event name must be 1-128 ASCII letters, digits, '.', "
          L"'_', or '-'");
    }
    termination_event_name = argv[next_index + 1];
    next_index += 2;
  }

  std::wstring completion_receipt_path;
  std::wstring receipt_token;
  if (next_index < argc &&
      std::wstring_view(argv[next_index]) == L"--completion-receipt") {
    if (next_index + 3 >= argc ||
        std::wstring_view(argv[next_index + 2]) != L"--receipt-token") {
      ExitUsage(
          L"completion receipt requires --completion-receipt <absolute-path> "
          L"--receipt-token <token>");
    }
    completion_receipt_path = argv[next_index + 1];
    receipt_token = argv[next_index + 3];
    if (!IsAbsoluteWindowsPath(completion_receipt_path) ||
        ContainsLineBreak(completion_receipt_path)) {
      ExitUsage(L"completion receipt path must be an absolute Windows path");
    }
    if (!IsNonEmptyAsciiToken(receipt_token)) {
      ExitUsage(L"receipt token must contain only non-whitespace ASCII characters");
    }
    next_index += 4;
  } else if (next_index < argc &&
             std::wstring_view(argv[next_index]) == L"--receipt-token") {
    ExitUsage(L"--receipt-token requires --completion-receipt");
  }

  if (termination_event_name.empty() != completion_receipt_path.empty()) {
    ExitUsage(
        L"--termination-event and --completion-receipt must be provided "
        L"together");
  }

  if (next_index + 1 >= argc ||
      std::wstring_view(argv[next_index]) != L"--") {
    ExitUsage(
        L"expected --protocol 2 --argument-mode argv|verbatim "
        L"[--job-name <name>] "
        L"[--termination-event <name>] "
        L"[--completion-receipt <absolute-path> --receipt-token <token>] "
        L"-- <target> [args...]");
  }

  const int target_index = next_index + 1;
  std::wstring target(argv[target_index]);
  std::vector<std::wstring> arguments;
  arguments.reserve(static_cast<std::size_t>(argc - target_index - 1));
  for (int index = target_index + 1; index < argc; ++index) {
    if (argument_mode == ArgumentMode::kVerbatim &&
        ContainsLineBreak(argv[index])) {
      ExitUsage(L"verbatim arguments cannot contain line breaks");
    }
    arguments.emplace_back(argv[index]);
  }
  return {argument_mode, std::move(target), std::move(arguments),
          std::move(job_name), std::move(termination_event_name),
          std::move(completion_receipt_path), std::move(receipt_token)};
}

[[nodiscard]] std::wstring BuildCommandLine(const LaunchRequest& request) {
  std::wstring command_line;
  AppendQuotedWindowsArgument(request.target, command_line);
  for (const std::wstring& argument : request.arguments) {
    command_line.push_back(L' ');
    if (request.argument_mode == ArgumentMode::kVerbatim) {
      command_line.append(argument);
    } else {
      AppendQuotedWindowsArgument(argument, command_line);
    }
  }
  return command_line;
}

[[nodiscard]] bool IsUsableStandardHandle(HANDLE handle) {
  if (handle == nullptr || handle == INVALID_HANDLE_VALUE) {
    return false;
  }
  SetLastError(ERROR_SUCCESS);
  const DWORD type = GetFileType(handle);
  return type != FILE_TYPE_UNKNOWN || GetLastError() == ERROR_SUCCESS;
}

[[nodiscard]] bool QueryJobEmpty(HANDLE job,
                                 bool& empty,
                                 DWORD& error_code) {
  JOBOBJECT_BASIC_ACCOUNTING_INFORMATION accounting{};
  if (!QueryInformationJobObject(job, JobObjectBasicAccountingInformation,
                                 &accounting, sizeof(accounting), nullptr)) {
    error_code = GetLastError();
    return false;
  }
  empty = accounting.ActiveProcesses == 0;
  error_code = ERROR_SUCCESS;
  return true;
}

enum class CompletionPortReadResult { kMessage, kTimedOut };

[[nodiscard]] CompletionPortReadResult ReadJobCompletionOrExitUnproven(
    HANDLE job,
    HANDLE completion_port,
    DWORD timeout_milliseconds,
    std::wstring_view stage,
    DWORD& completion_code) {
  ULONG_PTR completion_key = 0;
  LPOVERLAPPED overlapped = nullptr;
  if (!GetQueuedCompletionStatus(completion_port, &completion_code,
                                 &completion_key, &overlapped,
                                 timeout_milliseconds)) {
    const DWORD wait_error = GetLastError();
    if (wait_error == WAIT_TIMEOUT) {
      return CompletionPortReadResult::kTimedOut;
    }
    ExitWithUnprovenJobFailure(stage, wait_error);
  }
  if (completion_key != reinterpret_cast<ULONG_PTR>(job)) {
    ExitWithUnprovenJobFailure(stage, ERROR_INVALID_DATA,
                               L"completion key did not match the Job");
  }
  return CompletionPortReadResult::kMessage;
}

[[nodiscard]] bool DrainLiveJobCompletionBatchOrExitUnproven(
    HANDLE job,
    HANDLE completion_port) {
  for (std::size_t index = 0; index < kLiveCompletionDrainBatchSize; ++index) {
    DWORD completion_code = 0;
    if (ReadJobCompletionOrExitUnproven(
            job, completion_port, 0, L"drain-live-completion-port",
            completion_code) == CompletionPortReadResult::kTimedOut) {
      return false;
    }
    // Live completion packets are hints only. In particular, nested Jobs can
    // forward ACTIVE_PROCESS_ZERO while this outer Job still has processes.
    // Discard them here and use authoritative accounting at final shutdown.
  }
  return true;
}

[[nodiscard]] DWORD WaitForRootProcessOrTerminationWhileDrainingJobCompletions(
    HANDLE process,
    HANDLE termination_event,
    HANDLE job,
    HANDLE completion_port) {
  const std::array<HANDLE, 2> wait_handles{process, termination_event};
  const DWORD wait_handle_count = termination_event == nullptr ? 1 : 2;
  DWORD wait_interval = 0;
  for (;;) {
    const DWORD wait_result = WaitForMultipleObjects(
        wait_handle_count, wait_handles.data(), FALSE, wait_interval);
    if (wait_result != WAIT_TIMEOUT) {
      return wait_result;
    }

    const bool batch_saturated =
        DrainLiveJobCompletionBatchOrExitUnproven(job, completion_port);
    // A full batch can mean producer churn is outrunning the timed cadence.
    // Recheck the root immediately, then keep draining without a sleep.
    wait_interval = batch_saturated ? 0 : kRootProcessPollIntervalMilliseconds;
  }
}

void WaitForJobEmptyOrExitUnproven(HANDLE job,
                                   HANDLE completion_port,
                                   DWORD termination_exit_code) {
  const ULONGLONG wait_started_at = GetTickCount64();
  bool empty = false;
  DWORD query_error = ERROR_SUCCESS;
  if (!QueryJobEmpty(job, empty, query_error)) {
    ExitWithUnprovenJobFailure(L"verify-job-empty", query_error);
  }
  if (empty) {
    return;
  }

  if (!TerminateJobObject(job, termination_exit_code)) {
    const DWORD terminate_error = GetLastError();
    if (!QueryJobEmpty(job, empty, query_error)) {
      ExitWithUnprovenJobFailure(L"verify-job-empty", query_error);
    }
    if (empty) {
      return;
    }
    ExitWithUnprovenJobFailure(L"terminate-job", terminate_error);
  }

  for (;;) {
    const ULONGLONG elapsed = GetTickCount64() - wait_started_at;
    if (elapsed >= kJobEmptyDeadlineMilliseconds) {
      ExitWithUnprovenJobFailure(
          L"wait-job-empty", ERROR_TIMEOUT,
          L"Job remained active beyond the completion deadline");
    }
    const ULONGLONG remaining = kJobEmptyDeadlineMilliseconds - elapsed;
    const DWORD wait_interval =
        remaining < kJobEmptyPollIntervalMilliseconds
            ? static_cast<DWORD>(remaining)
            : kJobEmptyPollIntervalMilliseconds;
    DWORD completion_code = 0;
    if (ReadJobCompletionOrExitUnproven(
            job, completion_port, wait_interval, L"wait-job-empty",
            completion_code) == CompletionPortReadResult::kTimedOut) {
      if (!QueryJobEmpty(job, empty, query_error)) {
        ExitWithUnprovenJobFailure(L"verify-job-empty", query_error);
      }
      if (empty) {
        return;
      }
      continue;
    }
    if (completion_code != JOB_OBJECT_MSG_ACTIVE_PROCESS_ZERO) {
      continue;
    }

    if (!QueryJobEmpty(job, empty, query_error)) {
      ExitWithUnprovenJobFailure(L"verify-job-empty", query_error);
    }
    if (!empty) {
      // Nested Jobs forward completion messages to parent completion ports,
      // and queued messages can describe an earlier state. Only current
      // accounting for this outer Job is authoritative, so keep polling.
      continue;
    }
    return;
  }
}

void WriteCompletionReceiptOrExit(const LaunchRequest& request) {
  if (request.completion_receipt_path.empty()) {
    return;
  }

  OwnedHandle receipt_file(CreateFileW(
      request.completion_receipt_path.c_str(), GENERIC_WRITE, 0, nullptr,
      CREATE_NEW, FILE_ATTRIBUTE_NORMAL | FILE_FLAG_WRITE_THROUGH, nullptr));
  if (!receipt_file) {
    ExitWithFailure(kReceiptExitCode, L"completion-receipt", GetLastError(),
                    L"could not create completion receipt");
  }

  std::string receipt;
  const std::string launcher_pid = std::to_string(GetCurrentProcessId());
  receipt.reserve(request.receipt_token.size() + launcher_pid.size() + 2);
  for (const wchar_t character : request.receipt_token) {
    receipt.push_back(static_cast<char>(character));
  }
  receipt.push_back('\n');
  receipt.append(launcher_pid);
  receipt.push_back('\n');

  const DWORD receipt_size = static_cast<DWORD>(receipt.size());
  DWORD bytes_written = 0;
  if (!WriteFile(receipt_file.get(), receipt.data(), receipt_size,
                 &bytes_written, nullptr) ||
      bytes_written != receipt_size) {
    DWORD error = GetLastError();
    if (error == ERROR_SUCCESS) {
      error = ERROR_WRITE_FAULT;
    }
    ExitWithFailure(kReceiptExitCode, L"completion-receipt", error,
                    L"could not write complete completion receipt");
  }
  if (!FlushFileBuffers(receipt_file.get())) {
    ExitWithFailure(kReceiptExitCode, L"completion-receipt", GetLastError(),
                    L"could not flush completion receipt");
  }
  const HANDLE raw_receipt_file = receipt_file.release();
  if (!CloseHandle(raw_receipt_file)) {
    ExitWithFailure(kReceiptExitCode, L"completion-receipt", GetLastError(),
                    L"could not close completion receipt");
  }
}

[[noreturn]] void ExitWithNoAssignedTreeFailure(
    const LaunchRequest& request,
    DWORD exit_code,
    std::wstring_view stage,
    DWORD error_code,
    std::wstring_view detail = {}) {
  WriteCompletionReceiptOrExit(request);
  ExitWithFailure(exit_code, stage, error_code, detail);
}

[[noreturn]] void ExitAssignedFailure(const LaunchRequest& request,
                                      OwnedHandle& job,
                                      OwnedHandle& completion_port,
                                      DWORD exit_code,
                                      std::wstring_view stage,
                                      DWORD error_code) {
  WaitForJobEmptyOrExitUnproven(job.get(), completion_port.get(), exit_code);
  job.reset();
  completion_port.reset();
  WriteCompletionReceiptOrExit(request);
  ExitWithFailure(exit_code, stage, error_code);
}

[[noreturn]] void SignalTerminationEventOrExit(int argc, wchar_t* argv[]) {
  DWORD launcher_process_id = 0;
  if (argc != 7 || std::wstring_view(argv[1]) != L"--protocol" ||
      std::wstring_view(argv[2]) != L"2" ||
      std::wstring_view(argv[3]) != L"--signal-termination-event" ||
      !IsValidKernelObjectName(argv[4]) ||
      std::wstring_view(argv[5]) != L"--launcher-pid" ||
      !ParseProcessId(argv[6], launcher_process_id)) {
    ExitUsage(
        L"expected --protocol 2 --signal-termination-event <name> "
        L"--launcher-pid <positive-pid>");
  }

  const std::wstring termination_event_name(argv[4]);
  OwnedHandle launcher_process(
      OpenProcess(SYNCHRONIZE, FALSE, launcher_process_id));
  if (!launcher_process) {
    const DWORD open_process_error = GetLastError();
    if (open_process_error == ERROR_INVALID_PARAMETER) {
      ExitProcess(ERROR_SUCCESS);
    }
    ExitWithFailure(kOpenTerminationEventExitCode, L"open-launcher-process",
                    open_process_error);
  }
  const ULONGLONG wait_started_at = GetTickCount64();
  OwnedHandle termination_event;
  for (;;) {
    const HANDLE opened_event = OpenEventW(
        EVENT_MODIFY_STATE, FALSE, termination_event_name.c_str());
    if (opened_event != nullptr) {
      termination_event.reset(opened_event);
      break;
    }

    const DWORD open_error = GetLastError();
    if (open_error != ERROR_FILE_NOT_FOUND) {
      ExitWithFailure(kOpenTerminationEventExitCode, L"open-termination-event",
                      open_error);
    }
    const DWORD launcher_wait = WaitForSingleObject(launcher_process.get(), 0);
    if (launcher_wait == WAIT_OBJECT_0) {
      ExitProcess(ERROR_SUCCESS);
    }
    if (launcher_wait == WAIT_FAILED) {
      ExitWithFailure(kOpenTerminationEventExitCode,
                      L"wait-launcher-process", GetLastError());
    }
    const ULONGLONG elapsed = GetTickCount64() - wait_started_at;
    if (elapsed >= kJobEmptyDeadlineMilliseconds) {
      ExitWithFailure(
          kOpenTerminationEventExitCode, L"open-termination-event",
          ERROR_TIMEOUT,
          L"owner termination event did not appear before the deadline");
    }
    const ULONGLONG remaining = kJobEmptyDeadlineMilliseconds - elapsed;
    Sleep(remaining < kOpenTerminationEventPollIntervalMilliseconds
              ? static_cast<DWORD>(remaining)
              : kOpenTerminationEventPollIntervalMilliseconds);
  }

  if (!SetEvent(termination_event.get())) {
    ExitWithFailure(kSignalTerminationEventExitCode,
                    L"signal-termination-event", GetLastError());
  }
  const HANDLE raw_termination_event = termination_event.release();
  if (!CloseHandle(raw_termination_event)) {
    ExitWithFailure(kSignalTerminationEventExitCode,
                    L"close-termination-event", GetLastError());
  }
  ExitProcess(ERROR_SUCCESS);
}

}  // namespace

int wmain(int argc, wchar_t* argv[]) {
  if (argc >= 4 && std::wstring_view(argv[1]) == L"--protocol" &&
      std::wstring_view(argv[2]) == L"2" &&
      std::wstring_view(argv[3]) == L"--signal-termination-event") {
    SignalTerminationEventOrExit(argc, argv);
  }

  const LaunchRequest request = ParseRequest(argc, argv);

  if (!IsAbsoluteWindowsPath(request.target)) {
    ExitWithNoAssignedTreeFailure(
        request, kTargetExitCode, L"target", ERROR_BAD_PATHNAME,
        L"target must be an absolute Windows path");
  }
  const DWORD target_attributes = GetFileAttributesW(request.target.c_str());
  if (target_attributes == INVALID_FILE_ATTRIBUTES ||
      (target_attributes & FILE_ATTRIBUTE_DIRECTORY) != 0) {
    const DWORD error = target_attributes == INVALID_FILE_ATTRIBUTES
                            ? GetLastError()
                            : ERROR_DIRECTORY;
    ExitWithNoAssignedTreeFailure(
        request, kTargetExitCode, L"target", error,
        L"target is not a regular executable file");
  }

  OwnedHandle termination_event;
  if (!request.termination_event_name.empty()) {
    SetLastError(ERROR_SUCCESS);
    const HANDLE raw_termination_event =
        CreateEventW(nullptr, FALSE, FALSE,
                     request.termination_event_name.c_str());
    const DWORD create_event_error = GetLastError();
    termination_event.reset(raw_termination_event);
    if (!termination_event) {
      ExitWithNoAssignedTreeFailure(
          request, kJobExitCode, L"create-termination-event",
          create_event_error);
    }
    if (create_event_error == ERROR_ALREADY_EXISTS) {
      termination_event.reset();
      ExitWithNoAssignedTreeFailure(
          request, kJobExitCode, L"create-termination-event",
          ERROR_ALREADY_EXISTS,
          L"refusing to reuse an existing termination event");
    }
  }

  SetLastError(ERROR_SUCCESS);
  const HANDLE raw_job = CreateJobObjectW(
      nullptr, request.job_name.empty() ? nullptr : request.job_name.c_str());
  const DWORD create_job_error = GetLastError();
  OwnedHandle job(raw_job);
  if (!job) {
    ExitWithNoAssignedTreeFailure(request, kJobExitCode, L"create-job",
                                  create_job_error);
  }
  if (!request.job_name.empty() &&
      create_job_error == ERROR_ALREADY_EXISTS) {
    job.reset();
    ExitWithNoAssignedTreeFailure(
        request, kJobExitCode, L"create-job", ERROR_ALREADY_EXISTS,
        L"refusing to reuse an existing named Job");
  }

  JOBOBJECT_EXTENDED_LIMIT_INFORMATION limits{};
  limits.BasicLimitInformation.LimitFlags =
      JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE |
      JOB_OBJECT_LIMIT_DIE_ON_UNHANDLED_EXCEPTION;
  if (!SetInformationJobObject(job.get(), JobObjectExtendedLimitInformation,
                               &limits, sizeof(limits))) {
    ExitWithNoAssignedTreeFailure(request, kJobExitCode, L"configure-job",
                                  GetLastError());
  }

  OwnedHandle completion_port(
      CreateIoCompletionPort(INVALID_HANDLE_VALUE, nullptr, 0, 1));
  if (!completion_port) {
    ExitWithNoAssignedTreeFailure(
        request, kJobExitCode, L"create-completion-port", GetLastError());
  }
  JOBOBJECT_ASSOCIATE_COMPLETION_PORT completion_port_association{};
  completion_port_association.CompletionKey = job.get();
  completion_port_association.CompletionPort = completion_port.get();
  if (!SetInformationJobObject(job.get(),
                               JobObjectAssociateCompletionPortInformation,
                               &completion_port_association,
                               sizeof(completion_port_association))) {
    ExitWithNoAssignedTreeFailure(
        request, kJobExitCode, L"associate-completion-port", GetLastError());
  }

  STARTUPINFOEXW startup{};
  startup.StartupInfo.cb = sizeof(startup);
  startup.StartupInfo.dwFlags = STARTF_USESHOWWINDOW;
  startup.StartupInfo.wShowWindow = SW_HIDE;

  std::array<HANDLE, 3> standard_handles{
      GetStdHandle(STD_INPUT_HANDLE),
      GetStdHandle(STD_OUTPUT_HANDLE),
      GetStdHandle(STD_ERROR_HANDLE),
  };
  std::vector<HANDLE> inherited_handles;
  inherited_handles.reserve(standard_handles.size());
  const bool has_complete_standard_handle_set =
      IsUsableStandardHandle(standard_handles[0]) &&
      IsUsableStandardHandle(standard_handles[1]) &&
      IsUsableStandardHandle(standard_handles[2]);
  if (has_complete_standard_handle_set) {
    startup.StartupInfo.dwFlags |= STARTF_USESTDHANDLES;
    startup.StartupInfo.hStdInput = standard_handles[0];
    startup.StartupInfo.hStdOutput = standard_handles[1];
    startup.StartupInfo.hStdError = standard_handles[2];

    for (const HANDLE handle : standard_handles) {
      bool duplicate = false;
      for (const HANDLE existing : inherited_handles) {
        if (existing == handle) {
          duplicate = true;
          break;
        }
      }
      if (duplicate) {
        continue;
      }
      if (!SetHandleInformation(handle, HANDLE_FLAG_INHERIT,
                                HANDLE_FLAG_INHERIT)) {
        ExitWithNoAssignedTreeFailure(
            request, kHandleExitCode, L"mark-stdio-inheritable",
            GetLastError());
      }
      inherited_handles.push_back(handle);
    }
  }

  AttributeList attributes;
  if (!attributes.initialize()) {
    ExitWithNoAssignedTreeFailure(
        request, kHandleExitCode, L"initialize-handle-list", GetLastError());
  }
  startup.lpAttributeList = attributes.get();
  if (!inherited_handles.empty() &&
      !UpdateProcThreadAttribute(
          startup.lpAttributeList, 0, PROC_THREAD_ATTRIBUTE_HANDLE_LIST,
          inherited_handles.data(), inherited_handles.size() * sizeof(HANDLE),
          nullptr, nullptr)) {
    ExitWithNoAssignedTreeFailure(
        request, kHandleExitCode, L"configure-handle-list", GetLastError());
  }

  std::wstring command_line = BuildCommandLine(request);
  PROCESS_INFORMATION process_info{};
  const DWORD creation_flags =
      CREATE_SUSPENDED | CREATE_UNICODE_ENVIRONMENT |
      CREATE_DEFAULT_ERROR_MODE | CREATE_NO_WINDOW |
      EXTENDED_STARTUPINFO_PRESENT;
  const BOOL created = CreateProcessW(
      request.target.c_str(), command_line.data(), nullptr, nullptr,
      inherited_handles.empty() ? FALSE : TRUE, creation_flags, nullptr,
      nullptr, &startup.StartupInfo, &process_info);
  if (!created) {
    ExitWithNoAssignedTreeFailure(
        request, kCreateProcessExitCode, L"create-process", GetLastError());
  }

  OwnedHandle process(process_info.hProcess);
  OwnedHandle primary_thread(process_info.hThread);

  if (!AssignProcessToJobObject(job.get(), process.get())) {
    const DWORD error = GetLastError();
    DWORD cleanup_error = ERROR_SUCCESS;
    if (!TerminateProcess(process.get(), kAssignProcessExitCode)) {
      cleanup_error = GetLastError();
    }
    const DWORD cleanup_wait = WaitForSingleObject(
        process.get(), static_cast<DWORD>(kJobEmptyDeadlineMilliseconds));
    if (cleanup_wait != WAIT_OBJECT_0) {
      if (cleanup_wait == WAIT_FAILED) {
        cleanup_error = GetLastError();
      } else if (cleanup_error == ERROR_SUCCESS) {
        cleanup_error = ERROR_TIMEOUT;
      }
      ExitWithUnprovenJobFailure(
          L"verify-unassigned-process-exit", cleanup_error,
          L"could not prove the suspended unassigned target exited");
    }
    primary_thread.reset();
    process.reset();
    ExitWithNoAssignedTreeFailure(request, kAssignProcessExitCode,
                                  L"assign-process", error);
  }

  if (ResumeThread(primary_thread.get()) == static_cast<DWORD>(-1)) {
    const DWORD error = GetLastError();
    primary_thread.reset();
    process.reset();
    ExitAssignedFailure(request, job, completion_port,
                        kResumeProcessExitCode, L"resume-process", error);
  }
  primary_thread.reset();

  const DWORD wait_result =
      WaitForRootProcessOrTerminationWhileDrainingJobCompletions(
          process.get(), termination_event.get(), job.get(),
          completion_port.get());
  if (wait_result == WAIT_OBJECT_0 + 1) {
    process.reset();
    WaitForJobEmptyOrExitUnproven(job.get(), completion_port.get(),
                                  ERROR_CANCELLED);
    job.reset();
    completion_port.reset();
    termination_event.reset();
    WriteCompletionReceiptOrExit(request);
    ExitProcess(ERROR_CANCELLED);
  }
  if (wait_result != WAIT_OBJECT_0) {
    const DWORD error =
        wait_result == WAIT_FAILED ? GetLastError() : ERROR_GEN_FAILURE;
    process.reset();
    ExitAssignedFailure(request, job, completion_port, kWaitProcessExitCode,
                        L"wait-process", error);
  }

  DWORD child_exit_code = 0;
  if (!GetExitCodeProcess(process.get(), &child_exit_code)) {
    const DWORD error = GetLastError();
    process.reset();
    ExitAssignedFailure(request, job, completion_port, kWaitProcessExitCode,
                        L"query-exit-code", error);
  }

  process.reset();
  // This is the provider lifetime boundary. The launcher cannot publish its
  // exit (or completion receipt) until Windows reports that every assigned
  // process is gone and a fresh accounting query confirms an empty Job.
  WaitForJobEmptyOrExitUnproven(job.get(), completion_port.get(),
                                child_exit_code);
  job.reset();
  completion_port.reset();
  termination_event.reset();
  WriteCompletionReceiptOrExit(request);
  ExitProcess(child_exit_code);
}
