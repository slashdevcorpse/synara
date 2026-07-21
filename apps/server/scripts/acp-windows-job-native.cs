using System;
using System.ComponentModel;
using System.Diagnostics;
using System.IO;
using System.Runtime.InteropServices;
using System.Text;
using System.Threading;
using Microsoft.Win32.SafeHandles;

namespace SynaraAcpJob
{
    public static class Program
    {
        public static int Main(string[] args)
        {
            if (args.Length != 3)
            {
                Console.Error.WriteLine("SYNARA_ACP_JOB_ERROR expected two encoded launch values and a parent PID");
                return 64;
            }
            try
            {
                string executable = Encoding.UTF8.GetString(Convert.FromBase64String(args[0]));
                string commandLine = Encoding.UTF8.GetString(Convert.FromBase64String(args[1]));
                uint parentProcessId;
                if (String.IsNullOrWhiteSpace(executable) || !Path.IsPathRooted(executable) ||
                    !File.Exists(executable) || executable.IndexOfAny(new[] { '\0', '\r', '\n' }) >= 0 ||
                    String.IsNullOrEmpty(commandLine) || commandLine.IndexOfAny(new[] { '\0', '\r', '\n' }) >= 0 ||
                    !UInt32.TryParse(args[2], out parentProcessId) || parentProcessId == 0)
                {
                    throw new InvalidOperationException("unsafe launch payload");
                }
                return NativeMethods.Run(executable, commandLine, parentProcessId);
            }
            catch (Exception error)
            {
                Console.Error.WriteLine("SYNARA_ACP_JOB_ERROR " + error.Message);
                Console.Error.Flush();
                return 70;
            }
        }
    }

    public sealed class SafeJobHandle : SafeHandleZeroOrMinusOneIsInvalid
    {
        public SafeJobHandle() : base(true) { }

        protected override bool ReleaseHandle()
        {
            return NativeMethods.CloseHandle(handle);
        }
    }

    public static class NativeMethods
    {
        private const uint JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE = 0x00002000;
        private const uint HANDLE_FLAG_INHERIT = 0x00000001;
        private const uint PROCESS_QUERY_LIMITED_INFORMATION = 0x00001000;
        private const uint SYNCHRONIZE = 0x00100000;
        private const uint STARTF_USESTDHANDLES = 0x00000100;
        private const int JobObjectBasicAccountingInformation = 1;
        private const int JobObjectExtendedLimitInformation = 9;
        private const int STD_INPUT_HANDLE = -10;
        private const int STD_OUTPUT_HANDLE = -11;
        private const int STD_ERROR_HANDLE = -12;
        private const uint WAIT_OBJECT_0 = 0;
        private const uint WAIT_TIMEOUT = 258;
        private const uint INFINITE = 0xffffffff;
        private const int DESCENDANT_EXIT_GRACE_MS = 1000;
        private const int PROVIDER_TERMINATION_TIMEOUT_MS = 5000;
        private const int PARENT_WATCHER_STOP_TIMEOUT_MS = 2000;

        [StructLayout(LayoutKind.Sequential)]
        private struct JOBOBJECT_BASIC_LIMIT_INFORMATION
        {
            public long PerProcessUserTimeLimit;
            public long PerJobUserTimeLimit;
            public uint LimitFlags;
            public UIntPtr MinimumWorkingSetSize;
            public UIntPtr MaximumWorkingSetSize;
            public uint ActiveProcessLimit;
            public UIntPtr Affinity;
            public uint PriorityClass;
            public uint SchedulingClass;
        }

        [StructLayout(LayoutKind.Sequential)]
        private struct IO_COUNTERS
        {
            public ulong ReadOperationCount;
            public ulong WriteOperationCount;
            public ulong OtherOperationCount;
            public ulong ReadTransferCount;
            public ulong WriteTransferCount;
            public ulong OtherTransferCount;
        }

        [StructLayout(LayoutKind.Sequential)]
        private struct JOBOBJECT_EXTENDED_LIMIT_INFORMATION
        {
            public JOBOBJECT_BASIC_LIMIT_INFORMATION BasicLimitInformation;
            public IO_COUNTERS IoInfo;
            public UIntPtr ProcessMemoryLimit;
            public UIntPtr JobMemoryLimit;
            public UIntPtr PeakProcessMemoryUsed;
            public UIntPtr PeakJobMemoryUsed;
        }

        [StructLayout(LayoutKind.Sequential)]
        private struct JOBOBJECT_BASIC_ACCOUNTING_INFORMATION
        {
            public long TotalUserTime;
            public long TotalKernelTime;
            public long ThisPeriodTotalUserTime;
            public long ThisPeriodTotalKernelTime;
            public uint TotalPageFaultCount;
            public uint TotalProcesses;
            public uint ActiveProcesses;
            public uint TotalTerminatedProcesses;
        }

        [StructLayout(LayoutKind.Sequential, CharSet = CharSet.Unicode)]
        private struct STARTUPINFO
        {
            public uint cb;
            public IntPtr lpReserved;
            public IntPtr lpDesktop;
            public IntPtr lpTitle;
            public uint dwX;
            public uint dwY;
            public uint dwXSize;
            public uint dwYSize;
            public uint dwXCountChars;
            public uint dwYCountChars;
            public uint dwFillAttribute;
            public uint dwFlags;
            public ushort wShowWindow;
            public ushort cbReserved2;
            public IntPtr lpReserved2;
            public IntPtr hStdInput;
            public IntPtr hStdOutput;
            public IntPtr hStdError;
        }

        [StructLayout(LayoutKind.Sequential)]
        private struct PROCESS_INFORMATION
        {
            public IntPtr hProcess;
            public IntPtr hThread;
            public uint dwProcessId;
            public uint dwThreadId;
        }

        [StructLayout(LayoutKind.Sequential)]
        private struct FILETIME
        {
            public uint LowDateTime;
            public uint HighDateTime;
        }

        [DllImport("kernel32.dll", CharSet = CharSet.Unicode, SetLastError = true, EntryPoint = "CreateJobObjectW")]
        private static extern SafeJobHandle CreateJobObject(IntPtr jobAttributes, string name);

        [DllImport("kernel32.dll", SetLastError = true)]
        [return: MarshalAs(UnmanagedType.Bool)]
        private static extern bool SetInformationJobObject(
            SafeJobHandle job,
            int informationClass,
            ref JOBOBJECT_EXTENDED_LIMIT_INFORMATION information,
            uint informationLength);

        [DllImport("kernel32.dll", SetLastError = true)]
        [return: MarshalAs(UnmanagedType.Bool)]
        private static extern bool QueryInformationJobObject(
            SafeJobHandle job,
            int informationClass,
            out JOBOBJECT_BASIC_ACCOUNTING_INFORMATION information,
            uint informationLength,
            IntPtr returnLength);

        [DllImport("kernel32.dll", SetLastError = true)]
        [return: MarshalAs(UnmanagedType.Bool)]
        private static extern bool AssignProcessToJobObject(SafeJobHandle job, IntPtr process);

        [DllImport("kernel32.dll", SetLastError = true)]
        [return: MarshalAs(UnmanagedType.Bool)]
        private static extern bool IsProcessInJob(
            IntPtr process,
            SafeJobHandle job,
            [MarshalAs(UnmanagedType.Bool)] out bool result);

        [DllImport("kernel32.dll", SetLastError = true)]
        [return: MarshalAs(UnmanagedType.Bool)]
        private static extern bool TerminateJobObject(SafeJobHandle job, uint exitCode);

        [DllImport("kernel32.dll", SetLastError = true)]
        [return: MarshalAs(UnmanagedType.Bool)]
        private static extern bool TerminateProcess(IntPtr process, uint exitCode);

        [DllImport("kernel32.dll", SetLastError = true)]
        [return: MarshalAs(UnmanagedType.Bool)]
        private static extern bool SetHandleInformation(IntPtr handle, uint mask, uint flags);

        [DllImport("kernel32.dll", SetLastError = true)]
        private static extern IntPtr OpenProcess(
            uint desiredAccess,
            [MarshalAs(UnmanagedType.Bool)] bool inheritHandle,
            uint processId);

        [DllImport("kernel32.dll", SetLastError = true)]
        [return: MarshalAs(UnmanagedType.Bool)]
        private static extern bool GetProcessTimes(
            IntPtr process,
            out FILETIME creationTime,
            out FILETIME exitTime,
            out FILETIME kernelTime,
            out FILETIME userTime);

        [DllImport("kernel32.dll", CharSet = CharSet.Unicode, SetLastError = true, EntryPoint = "CreateEventW")]
        private static extern IntPtr CreateEvent(
            IntPtr eventAttributes,
            [MarshalAs(UnmanagedType.Bool)] bool manualReset,
            [MarshalAs(UnmanagedType.Bool)] bool initialState,
            string name);

        [DllImport("kernel32.dll", SetLastError = true)]
        [return: MarshalAs(UnmanagedType.Bool)]
        private static extern bool SetEvent(IntPtr eventHandle);

        [DllImport("kernel32.dll", SetLastError = true)]
        private static extern uint WaitForMultipleObjects(
            uint count,
            [In] IntPtr[] handles,
            [MarshalAs(UnmanagedType.Bool)] bool waitAll,
            uint milliseconds);

        [DllImport("kernel32.dll", SetLastError = true)]
        private static extern IntPtr GetStdHandle(int standardHandle);

        [DllImport("kernel32.dll", SetLastError = true)]
        private static extern IntPtr GetCurrentProcess();

        [DllImport("kernel32.dll", CharSet = CharSet.Unicode, SetLastError = true, EntryPoint = "CreateProcessW")]
        [return: MarshalAs(UnmanagedType.Bool)]
        private static extern bool CreateProcess(
            string applicationName,
            StringBuilder commandLine,
            IntPtr processAttributes,
            IntPtr threadAttributes,
            [MarshalAs(UnmanagedType.Bool)] bool inheritHandles,
            uint creationFlags,
            IntPtr environment,
            string currentDirectory,
            ref STARTUPINFO startupInfo,
            out PROCESS_INFORMATION processInformation);

        [DllImport("kernel32.dll", SetLastError = true)]
        private static extern uint WaitForSingleObject(IntPtr handle, uint milliseconds);

        [DllImport("kernel32.dll", SetLastError = true)]
        [return: MarshalAs(UnmanagedType.Bool)]
        private static extern bool GetExitCodeProcess(IntPtr process, out uint exitCode);

        [DllImport("kernel32.dll", SetLastError = true)]
        [return: MarshalAs(UnmanagedType.Bool)]
        internal static extern bool CloseHandle(IntPtr handle);

        private static Win32Exception LastError(string operation)
        {
            return new Win32Exception(Marshal.GetLastWin32Error(), operation + " failed");
        }

        private static void ConfigureKillOnClose(SafeJobHandle job, bool enabled)
        {
            JOBOBJECT_EXTENDED_LIMIT_INFORMATION information =
                new JOBOBJECT_EXTENDED_LIMIT_INFORMATION();
            information.BasicLimitInformation.LimitFlags =
                enabled ? JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE : 0;
            uint size = (uint)Marshal.SizeOf(typeof(JOBOBJECT_EXTENDED_LIMIT_INFORMATION));
            if (!SetInformationJobObject(job, JobObjectExtendedLimitInformation, ref information, size))
            {
                throw LastError("SetInformationJobObject");
            }
        }

        private static uint ActiveProcessCount(SafeJobHandle job)
        {
            JOBOBJECT_BASIC_ACCOUNTING_INFORMATION information;
            uint size = (uint)Marshal.SizeOf(typeof(JOBOBJECT_BASIC_ACCOUNTING_INFORMATION));
            if (!QueryInformationJobObject(
                job,
                JobObjectBasicAccountingInformation,
                out information,
                size,
                IntPtr.Zero))
            {
                throw LastError("QueryInformationJobObject");
            }
            return information.ActiveProcesses;
        }

        private static void FailClosed(SafeJobHandle job, string message)
        {
            Console.Error.WriteLine("SYNARA_ACP_JOB_ERROR " + message);
            Console.Error.Flush();
            if (!TerminateJobObject(job, 137))
            {
                Environment.FailFast(message, LastError("TerminateJobObject"));
            }
            Thread.Sleep(Timeout.Infinite);
        }

        private static long FileTimeValue(FILETIME value)
        {
            return ((long)value.HighDateTime << 32) | value.LowDateTime;
        }

        private static IntPtr OpenAndValidateParent(uint parentProcessId)
        {
            IntPtr parentProcess = OpenProcess(
                SYNCHRONIZE | PROCESS_QUERY_LIMITED_INFORMATION,
                false,
                parentProcessId);
            if (parentProcess == IntPtr.Zero)
            {
                throw LastError("OpenProcess(parent)");
            }

            try
            {
                FILETIME parentCreation;
                FILETIME parentExit;
                FILETIME parentKernel;
                FILETIME parentUser;
                FILETIME wrapperCreation;
                FILETIME wrapperExit;
                FILETIME wrapperKernel;
                FILETIME wrapperUser;
                if (!GetProcessTimes(
                        parentProcess,
                        out parentCreation,
                        out parentExit,
                        out parentKernel,
                        out parentUser) ||
                    !GetProcessTimes(
                        GetCurrentProcess(),
                        out wrapperCreation,
                        out wrapperExit,
                        out wrapperKernel,
                        out wrapperUser))
                {
                    throw LastError("GetProcessTimes(parent)");
                }
                // A PID reused after the real parent died necessarily belongs to a process created
                // after this already-created wrapper. Keep the durable process handle only when its
                // creation identity proves it predates the wrapper.
                if (FileTimeValue(parentCreation) >= FileTimeValue(wrapperCreation))
                {
                    throw new InvalidOperationException("parent process identity is not older than the wrapper");
                }
                return parentProcess;
            }
            catch
            {
                CloseHandle(parentProcess);
                throw;
            }
        }

        private static Thread StartParentWatcher(
            SafeJobHandle job,
            IntPtr parentProcess,
            IntPtr stopEvent)
        {
            Thread watcher = new Thread(() =>
            {
                uint wait = WaitForMultipleObjects(
                    2,
                    new[] { parentProcess, stopEvent },
                    false,
                    INFINITE);
                if (wait == WAIT_OBJECT_0)
                {
                    if (!TerminateJobObject(job, 137))
                    {
                        Environment.FailFast(
                            "Failed to terminate the ACP Job after parent exit.",
                            LastError("TerminateJobObject(parent exit)"));
                    }
                    Thread.Sleep(Timeout.Infinite);
                }
                if (wait != WAIT_OBJECT_0 + 1)
                {
                    Environment.FailFast(
                        "ACP parent watcher wait failed.",
                        LastError("WaitForMultipleObjects(parent)"));
                }
            });
            watcher.IsBackground = true;
            watcher.Name = "Synara ACP parent watcher";
            watcher.Start();
            return watcher;
        }

        private static void StopParentWatcher(
            SafeJobHandle job,
            Thread watcher,
            IntPtr stopEvent)
        {
            if (!SetEvent(stopEvent))
            {
                FailClosed(job, "parent watcher stop signal failed");
            }
            if (!watcher.Join(PARENT_WATCHER_STOP_TIMEOUT_MS))
            {
                FailClosed(job, "parent watcher did not stop");
            }
        }

        public static int Run(string executable, string commandLine, uint parentProcessId)
        {
            IntPtr parentProcess = OpenAndValidateParent(parentProcessId);
            IntPtr parentWatcherStop = CreateEvent(IntPtr.Zero, true, false, null);
            if (parentWatcherStop == IntPtr.Zero)
            {
                CloseHandle(parentProcess);
                throw LastError("CreateEventW(parent watcher)");
            }

            try
            {
                SafeJobHandle job = CreateJobObject(IntPtr.Zero, null);
                if (job == null || job.IsInvalid)
                {
                    if (job != null) job.Dispose();
                    throw LastError("CreateJobObjectW");
                }

                using (job)
                {
                    ConfigureKillOnClose(job, true);
                    if (!SetHandleInformation(job.DangerousGetHandle(), HANDLE_FLAG_INHERIT, 0))
                    {
                        throw LastError("SetHandleInformation(job)");
                    }
                    if (!AssignProcessToJobObject(job, GetCurrentProcess()))
                    {
                        throw LastError("AssignProcessToJobObject(wrapper)");
                    }
                    Thread parentWatcher = StartParentWatcher(job, parentProcess, parentWatcherStop);

                    try
                    {
                        STARTUPINFO startup = new STARTUPINFO();
                        startup.cb = (uint)Marshal.SizeOf(typeof(STARTUPINFO));
                        startup.dwFlags = STARTF_USESTDHANDLES;
                        startup.hStdInput = GetStdHandle(STD_INPUT_HANDLE);
                        startup.hStdOutput = GetStdHandle(STD_OUTPUT_HANDLE);
                        startup.hStdError = GetStdHandle(STD_ERROR_HANDLE);
                        foreach (IntPtr handle in new[] { startup.hStdInput, startup.hStdOutput, startup.hStdError })
                        {
                            if (handle == IntPtr.Zero || handle == new IntPtr(-1) ||
                                !SetHandleInformation(handle, HANDLE_FLAG_INHERIT, HANDLE_FLAG_INHERIT))
                            {
                                ConfigureKillOnClose(job, false);
                                throw LastError("SetHandleInformation(stdio)");
                            }
                        }

                        PROCESS_INFORMATION child;
                        if (!CreateProcess(
                            executable,
                            new StringBuilder(commandLine),
                            IntPtr.Zero,
                            IntPtr.Zero,
                            true,
                            0,
                            IntPtr.Zero,
                            null,
                            ref startup,
                            out child))
                        {
                            ConfigureKillOnClose(job, false);
                            throw LastError("CreateProcessW(provider)");
                        }

                        try
                        {
                            bool assigned;
                            if (!IsProcessInJob(child.hProcess, job, out assigned) || !assigned)
                            {
                                if (!TerminateProcess(child.hProcess, 137) ||
                                    WaitForSingleObject(
                                        child.hProcess,
                                        PROVIDER_TERMINATION_TIMEOUT_MS) != WAIT_OBJECT_0)
                                {
                                    FailClosed(job, "uncontained provider could not be terminated");
                                }
                                ConfigureKillOnClose(job, false);
                                throw new InvalidOperationException(
                                    "provider process did not inherit the owning Job Object");
                            }
                            CloseHandle(child.hThread);
                            child.hThread = IntPtr.Zero;
                            if (WaitForSingleObject(child.hProcess, INFINITE) != WAIT_OBJECT_0)
                            {
                                FailClosed(job, "provider wait failed");
                            }
                            uint exitCode;
                            if (!GetExitCodeProcess(child.hProcess, out exitCode))
                            {
                                FailClosed(job, "provider exit code could not be read");
                            }

                            Stopwatch grace = Stopwatch.StartNew();
                            while (ActiveProcessCount(job) > 1 && grace.ElapsedMilliseconds < DESCENDANT_EXIT_GRACE_MS)
                            {
                                Thread.Sleep(25);
                            }
                            if (ActiveProcessCount(job) > 1)
                            {
                                FailClosed(job, "provider descendants survived root exit");
                            }

                            ConfigureKillOnClose(job, false);
                            return unchecked((int)exitCode);
                        }
                        finally
                        {
                            if (child.hThread != IntPtr.Zero) CloseHandle(child.hThread);
                            if (child.hProcess != IntPtr.Zero) CloseHandle(child.hProcess);
                        }
                    }
                    finally
                    {
                        StopParentWatcher(job, parentWatcher, parentWatcherStop);
                    }
                }
            }
            finally
            {
                CloseHandle(parentWatcherStop);
                CloseHandle(parentProcess);
            }
        }
    }
}
