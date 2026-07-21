// FILE: launcher.cpp
// Purpose: Starts one Windows provider tree inside an atomic kill-on-close Job Object.
// Layer: Server native process supervision helper
// Protocol: synara-windows-job-launcher --protocol 2 --argument-mode argv|verbatim
//           --control-file <absolute-path> -- <target> [args...]

#define WIN32_LEAN_AND_MEAN
#define NOMINMAX
#include <windows.h>

#include <array>
#include <cstddef>
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
constexpr DWORD kDrainJobExitCode = 248;
constexpr DWORD kControlExitCode = 249;
constexpr DWORD kControlledStopExitCode = 143;
constexpr DWORD kControlPollMilliseconds = 10;
constexpr ULONGLONG kJobDrainTimeoutMilliseconds = 5'000;
constexpr std::size_t kMaxTrackedJobProcesses = 1'024;
constexpr char kDrainAcknowledgement[] = "drained\n";

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

[[noreturn]] void ExitWithFailure(DWORD exit_code,
                                  std::wstring_view stage,
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
  ExitProcess(exit_code);
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
  std::wstring control_file;
  std::wstring target;
  std::vector<std::wstring> arguments;
};

[[nodiscard]] LaunchRequest ParseRequest(int argc, wchar_t* argv[]) {
  if (argc < 9 || std::wstring_view(argv[1]) != L"--protocol" ||
      std::wstring_view(argv[2]) != L"2" ||
      std::wstring_view(argv[3]) != L"--argument-mode" ||
      std::wstring_view(argv[5]) != L"--control-file" ||
      std::wstring_view(argv[7]) != L"--") {
    ExitUsage(
        L"expected --protocol 2 --argument-mode argv|verbatim --control-file "
        L"<absolute-path> -- <target> [args...]");
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

  std::wstring control_file(argv[6]);
  if (!IsAbsoluteWindowsPath(control_file)) {
    ExitUsage(L"control file must be an absolute Windows path");
  }

  std::wstring target(argv[8]);
  if (!IsAbsoluteWindowsPath(target)) {
    ExitWithFailure(kTargetExitCode, L"target", ERROR_BAD_PATHNAME,
                    L"target must be an absolute Windows path");
  }
  const DWORD attributes = GetFileAttributesW(target.c_str());
  if (attributes == INVALID_FILE_ATTRIBUTES ||
      (attributes & FILE_ATTRIBUTE_DIRECTORY) != 0) {
    const DWORD error = attributes == INVALID_FILE_ATTRIBUTES
                            ? GetLastError()
                            : ERROR_DIRECTORY;
    ExitWithFailure(kTargetExitCode, L"target", error,
                    L"target is not a regular executable file");
  }

  std::vector<std::wstring> arguments;
  arguments.reserve(static_cast<std::size_t>(argc - 9));
  for (int index = 9; index < argc; ++index) {
    if (argument_mode == ArgumentMode::kVerbatim &&
        ContainsLineBreak(argv[index])) {
      ExitUsage(L"verbatim arguments cannot contain line breaks");
    }
    arguments.emplace_back(argv[index]);
  }
  return {argument_mode, std::move(control_file), std::move(target),
          std::move(arguments)};
}

[[nodiscard]] bool ControlStopRequested(const std::wstring& control_file) {
  const DWORD attributes = GetFileAttributesW(control_file.c_str());
  if (attributes != INVALID_FILE_ATTRIBUTES) {
    return (attributes & FILE_ATTRIBUTE_DIRECTORY) == 0;
  }
  const DWORD error = GetLastError();
  if (error == ERROR_FILE_NOT_FOUND || error == ERROR_PATH_NOT_FOUND) {
    return false;
  }
  ExitWithFailure(kControlExitCode, L"read-control", error);
}

struct TrackedProcess final {
  DWORD process_id;
  OwnedHandle handle;
};

void CaptureActiveJobProcesses(HANDLE job,
                               std::vector<TrackedProcess>& tracked_processes) {
  // Two DWORD counters occupy the first ULONG_PTR on 64-bit Windows. Keep one extra slot for
  // 32-bit layout even though the published launcher architectures are currently 64-bit.
  std::array<ULONG_PTR, kMaxTrackedJobProcesses + 2> storage{};
  auto* process_list =
      reinterpret_cast<JOBOBJECT_BASIC_PROCESS_ID_LIST*>(storage.data());
  if (!QueryInformationJobObject(
          job, JobObjectBasicProcessIdList, process_list,
          static_cast<DWORD>(storage.size() * sizeof(storage[0])), nullptr)) {
    ExitWithFailure(kDrainJobExitCode, L"query-job-processes", GetLastError());
  }
  if (process_list->NumberOfAssignedProcesses >
      process_list->NumberOfProcessIdsInList) {
    ExitWithFailure(kDrainJobExitCode, L"query-job-processes",
                    ERROR_INSUFFICIENT_BUFFER);
  }

  for (DWORD index = 0; index < process_list->NumberOfProcessIdsInList;
       ++index) {
    const ULONG_PTR raw_process_id = process_list->ProcessIdList[index];
    const DWORD process_id = static_cast<DWORD>(raw_process_id);
    bool already_tracked = false;
    for (const TrackedProcess& tracked : tracked_processes) {
      if (tracked.process_id == process_id) {
        already_tracked = true;
        break;
      }
    }
    if (already_tracked) {
      continue;
    }

    OwnedHandle process_handle(OpenProcess(
        SYNCHRONIZE | PROCESS_QUERY_LIMITED_INFORMATION, FALSE, process_id));
    if (!process_handle) {
      const DWORD error = GetLastError();
      if (error == ERROR_INVALID_PARAMETER) {
        continue;
      }
      ExitWithFailure(kDrainJobExitCode, L"open-job-process", error);
    }
    BOOL belongs_to_job = FALSE;
    if (!IsProcessInJob(process_handle.get(), job, &belongs_to_job)) {
      ExitWithFailure(kDrainJobExitCode, L"verify-job-process", GetLastError());
    }
    if (belongs_to_job) {
      tracked_processes.push_back(
          TrackedProcess{process_id, std::move(process_handle)});
    }
  }
}

void WaitForEmptyJob(HANDLE job,
                     std::vector<TrackedProcess>& tracked_processes) {
  const ULONGLONG deadline = GetTickCount64() + kJobDrainTimeoutMilliseconds;
  for (;;) {
    CaptureActiveJobProcesses(job, tracked_processes);
    JOBOBJECT_BASIC_ACCOUNTING_INFORMATION accounting{};
    if (!QueryInformationJobObject(job, JobObjectBasicAccountingInformation,
                                   &accounting, sizeof(accounting), nullptr)) {
      ExitWithFailure(kDrainJobExitCode, L"query-job-drain", GetLastError());
    }
    if (accounting.ActiveProcesses == 0) {
      break;
    }
    if (GetTickCount64() >= deadline) {
      ExitWithFailure(kDrainJobExitCode, L"wait-job-drain", WAIT_TIMEOUT);
    }
    Sleep(1);
  }

  for (const TrackedProcess& tracked : tracked_processes) {
    const ULONGLONG now = GetTickCount64();
    const DWORD remaining =
        now >= deadline ? 0 : static_cast<DWORD>(deadline - now);
    const DWORD wait_result = WaitForSingleObject(tracked.handle.get(), remaining);
    if (wait_result != WAIT_OBJECT_0) {
      const DWORD error =
          wait_result == WAIT_FAILED ? GetLastError() : WAIT_TIMEOUT;
      ExitWithFailure(kDrainJobExitCode, L"wait-job-process", error);
    }
  }
  tracked_processes.clear();
}

void RemoveControlFileIfPresent(const std::wstring& control_file) {
  if (DeleteFileW(control_file.c_str())) {
    return;
  }
  const DWORD error = GetLastError();
  if (error != ERROR_FILE_NOT_FOUND && error != ERROR_PATH_NOT_FOUND) {
    ExitWithFailure(kControlExitCode, L"remove-control", error);
  }
}

void WriteDrainAcknowledgement(const std::wstring& control_file) {
  const std::wstring acknowledgement_file = control_file + L".drained";
  const std::wstring temporary_file = acknowledgement_file + L".tmp";
  HANDLE acknowledgement =
      CreateFileW(temporary_file.c_str(), GENERIC_WRITE, 0, nullptr,
                  CREATE_NEW, FILE_ATTRIBUTE_NORMAL, nullptr);
  if (acknowledgement == INVALID_HANDLE_VALUE) {
    ExitWithFailure(kControlExitCode, L"create-drain-acknowledgement",
                    GetLastError());
  }

  DWORD bytes_written = 0;
  const BOOL wrote = WriteFile(
      acknowledgement, kDrainAcknowledgement,
      static_cast<DWORD>(sizeof(kDrainAcknowledgement) - 1), &bytes_written,
      nullptr);
  if (!wrote || bytes_written != sizeof(kDrainAcknowledgement) - 1) {
    const DWORD error = wrote ? ERROR_WRITE_FAULT : GetLastError();
    CloseHandle(acknowledgement);
    DeleteFileW(temporary_file.c_str());
    ExitWithFailure(kControlExitCode, L"write-drain-acknowledgement", error);
  }
  if (!FlushFileBuffers(acknowledgement)) {
    const DWORD error = GetLastError();
    CloseHandle(acknowledgement);
    DeleteFileW(temporary_file.c_str());
    ExitWithFailure(kControlExitCode, L"flush-drain-acknowledgement", error);
  }
  if (!CloseHandle(acknowledgement)) {
    const DWORD error = GetLastError();
    DeleteFileW(temporary_file.c_str());
    ExitWithFailure(kControlExitCode, L"close-drain-acknowledgement", error);
  }
  if (!MoveFileExW(temporary_file.c_str(), acknowledgement_file.c_str(),
                   MOVEFILE_WRITE_THROUGH)) {
    const DWORD error = GetLastError();
    DeleteFileW(temporary_file.c_str());
    ExitWithFailure(kControlExitCode, L"publish-drain-acknowledgement", error);
  }
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

}  // namespace

int wmain(int argc, wchar_t* argv[]) {
  const LaunchRequest request = ParseRequest(argc, argv);

  OwnedHandle job(CreateJobObjectW(nullptr, nullptr));
  if (!job) {
    ExitWithFailure(kJobExitCode, L"create-job", GetLastError());
  }

  JOBOBJECT_EXTENDED_LIMIT_INFORMATION limits{};
  limits.BasicLimitInformation.LimitFlags =
      JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE |
      JOB_OBJECT_LIMIT_DIE_ON_UNHANDLED_EXCEPTION;
  if (!SetInformationJobObject(job.get(), JobObjectExtendedLimitInformation,
                               &limits, sizeof(limits))) {
    ExitWithFailure(kJobExitCode, L"configure-job", GetLastError());
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
        ExitWithFailure(kHandleExitCode, L"mark-stdio-inheritable",
                        GetLastError());
      }
      inherited_handles.push_back(handle);
    }
  }

  AttributeList attributes;
  if (!attributes.initialize()) {
    ExitWithFailure(kHandleExitCode, L"initialize-handle-list",
                    GetLastError());
  }
  startup.lpAttributeList = attributes.get();
  if (!inherited_handles.empty() &&
      !UpdateProcThreadAttribute(
          startup.lpAttributeList, 0, PROC_THREAD_ATTRIBUTE_HANDLE_LIST,
          inherited_handles.data(), inherited_handles.size() * sizeof(HANDLE),
          nullptr, nullptr)) {
    ExitWithFailure(kHandleExitCode, L"configure-handle-list", GetLastError());
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
    ExitWithFailure(kCreateProcessExitCode, L"create-process", GetLastError());
  }

  OwnedHandle process(process_info.hProcess);
  OwnedHandle primary_thread(process_info.hThread);

  if (!AssignProcessToJobObject(job.get(), process.get())) {
    const DWORD error = GetLastError();
    TerminateProcess(process.get(), kAssignProcessExitCode);
    WaitForSingleObject(process.get(),
                        static_cast<DWORD>(kJobDrainTimeoutMilliseconds));
    ExitWithFailure(kAssignProcessExitCode, L"assign-process", error);
  }

  if (ResumeThread(primary_thread.get()) == static_cast<DWORD>(-1)) {
    const DWORD error = GetLastError();
    TerminateJobObject(job.get(), kResumeProcessExitCode);
    std::vector<TrackedProcess> tracked_processes;
    WaitForEmptyJob(job.get(), tracked_processes);
    ExitWithFailure(kResumeProcessExitCode, L"resume-process", error);
  }
  primary_thread.reset();

  bool controlled_stop = false;
  std::vector<TrackedProcess> tracked_processes;
  for (;;) {
    const DWORD wait_result =
        WaitForSingleObject(process.get(), kControlPollMilliseconds);
    if (wait_result == WAIT_OBJECT_0) {
      break;
    }
    if (wait_result == WAIT_TIMEOUT) {
      if (ControlStopRequested(request.control_file)) {
        controlled_stop = true;
        CaptureActiveJobProcesses(job.get(), tracked_processes);
        if (!TerminateJobObject(job.get(), kControlledStopExitCode)) {
          ExitWithFailure(kControlExitCode, L"terminate-job", GetLastError());
        }
        break;
      }
      continue;
    }
    const DWORD error = wait_result == WAIT_FAILED ? GetLastError() : ERROR_GEN_FAILURE;
    TerminateJobObject(job.get(), kWaitProcessExitCode);
    ExitWithFailure(kWaitProcessExitCode, L"wait-process", error);
  }

  DWORD child_exit_code = controlled_stop ? kControlledStopExitCode : 0;
  if (!controlled_stop && !GetExitCodeProcess(process.get(), &child_exit_code)) {
    const DWORD error = GetLastError();
    TerminateJobObject(job.get(), kWaitProcessExitCode);
    ExitWithFailure(kWaitProcessExitCode, L"query-exit-code", error);
  }

  // Terminate any descendants that outlived the provider root, then hold the wrapper open until
  // Windows reports no active Job members. The acknowledgement is published only after every
  // fallible cleanup operation, so wrapper exit alone can never be mistaken for drain proof.
  if (!controlled_stop) {
    CaptureActiveJobProcesses(job.get(), tracked_processes);
    if (!TerminateJobObject(job.get(), child_exit_code)) {
      ExitWithFailure(kDrainJobExitCode, L"terminate-surviving-job-processes",
                      GetLastError());
    }
  }
  WaitForEmptyJob(job.get(), tracked_processes);
  process.reset();
  job.reset();
  RemoveControlFileIfPresent(request.control_file);
  WriteDrainAcknowledgement(request.control_file);
  ExitProcess(child_exit_code);
}
