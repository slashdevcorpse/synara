$ErrorActionPreference = "Stop"
$ProgressPreference = "SilentlyContinue"
Set-StrictMode -Version 2

function Write-SmokeJobError([string]$Message, [int]$ExitCode = 70) {
  [Console]::Error.WriteLine("SYNARA_SMOKE_JOB_ERROR " + $Message)
  [Console]::Error.Flush()
  [Environment]::Exit($ExitCode)
}

function Test-SmokeJobFullyQualifiedPath([string]$Path) {
  if ([string]::IsNullOrEmpty($Path) -or $Path -match "[`0`r`n]") {
    return $false
  }
  return (
    $Path -match '^[A-Za-z]:[\\/]' -or
    $Path -match '^\\\\[^\\/:*?"<>|]+[\\/][^\\/:*?"<>|]+(?:[\\/].*)?$'
  )
}

$runId = [Environment]::GetEnvironmentVariable("SYNARA_SMOKE_JOB_RUN_ID")
if (
  [string]::IsNullOrWhiteSpace($runId) -or
  $runId -notmatch "^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[1-5][0-9a-fA-F]{3}-[89abAB][0-9a-fA-F]{3}-[0-9a-fA-F]{12}$"
) {
  Write-SmokeJobError "missing or invalid run id"
}

$commandParts = @($args)
if ($commandParts.Count -lt 2 -or $commandParts[0] -ne "--") {
  Write-SmokeJobError "expected -- followed by an executable"
}
$executablePath = $commandParts[1]
if (!(Test-SmokeJobFullyQualifiedPath $executablePath) -or ![IO.File]::Exists($executablePath)) {
  Write-SmokeJobError "executable path is not an existing absolute file"
}
$childArguments = @()
if ($commandParts.Count -gt 2) {
  $childArguments = @($commandParts[2..($commandParts.Count - 1)])
}

$nativeSource = @'
using System;
using System.ComponentModel;
using System.IO;
using System.Runtime.InteropServices;
using System.Threading;
using System.Threading.Tasks;
using Microsoft.Win32.SafeHandles;

namespace SynaraDesktopSmoke
{
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
        private const int JobObjectExtendedLimitInformation = 9;
        private static SafeJobHandle jobHandle;

        [StructLayout(LayoutKind.Sequential)]
        public struct JOBOBJECT_BASIC_LIMIT_INFORMATION
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
        public struct IO_COUNTERS
        {
            public ulong ReadOperationCount;
            public ulong WriteOperationCount;
            public ulong OtherOperationCount;
            public ulong ReadTransferCount;
            public ulong WriteTransferCount;
            public ulong OtherTransferCount;
        }

        [StructLayout(LayoutKind.Sequential)]
        public struct JOBOBJECT_EXTENDED_LIMIT_INFORMATION
        {
            public JOBOBJECT_BASIC_LIMIT_INFORMATION BasicLimitInformation;
            public IO_COUNTERS IoInfo;
            public UIntPtr ProcessMemoryLimit;
            public UIntPtr JobMemoryLimit;
            public UIntPtr PeakProcessMemoryUsed;
            public UIntPtr PeakJobMemoryUsed;
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
        private static extern bool AssignProcessToJobObject(SafeJobHandle job, IntPtr process);

        [DllImport("kernel32.dll", SetLastError = true)]
        [return: MarshalAs(UnmanagedType.Bool)]
        private static extern bool TerminateJobObject(SafeJobHandle job, uint exitCode);

        [DllImport("kernel32.dll", SetLastError = true)]
        [return: MarshalAs(UnmanagedType.Bool)]
        private static extern bool SetHandleInformation(
            SafeJobHandle handle,
            uint mask,
            uint flags);

        [DllImport("kernel32.dll", SetLastError = true)]
        private static extern IntPtr GetCurrentProcess();

        [DllImport("kernel32.dll", SetLastError = true)]
        [return: MarshalAs(UnmanagedType.Bool)]
        internal static extern bool CloseHandle(IntPtr handle);

        private static Win32Exception LastWin32Error(string operation)
        {
            return new Win32Exception(Marshal.GetLastWin32Error(), operation + " failed");
        }

        public static void InitializeJobAndControl(string expectedToken)
        {
            JOBOBJECT_EXTENDED_LIMIT_INFORMATION information =
                new JOBOBJECT_EXTENDED_LIMIT_INFORMATION();
            int informationSize =
                Marshal.SizeOf(typeof(JOBOBJECT_EXTENDED_LIMIT_INFORMATION));
            if (IntPtr.Size == 8 && informationSize != 144)
            {
                throw new InvalidOperationException(
                    "unexpected JOBOBJECT_EXTENDED_LIMIT_INFORMATION size " + informationSize);
            }

            SafeJobHandle createdJob = CreateJobObject(IntPtr.Zero, null);
            int createError = Marshal.GetLastWin32Error();
            if (createdJob == null || createdJob.IsInvalid)
            {
                if (createdJob != null) createdJob.Dispose();
                throw new Win32Exception(createError, "CreateJobObjectW failed");
            }

            try
            {
                information.BasicLimitInformation.LimitFlags =
                    JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE;
                if (!SetInformationJobObject(
                    createdJob,
                    JobObjectExtendedLimitInformation,
                    ref information,
                    (uint)informationSize))
                {
                    throw LastWin32Error("SetInformationJobObject");
                }
                if (!SetHandleInformation(createdJob, HANDLE_FLAG_INHERIT, 0))
                {
                    throw LastWin32Error("SetHandleInformation");
                }
                if (!AssignProcessToJobObject(createdJob, GetCurrentProcess()))
                {
                    throw LastWin32Error("AssignProcessToJobObject");
                }

                jobHandle = createdJob;
                createdJob = null;
                Thread controlThread = new Thread(ControlMain);
                controlThread.IsBackground = true;
                controlThread.Name = "Synara smoke Job Object control";
                controlThread.Start(expectedToken);
            }
            finally
            {
                if (createdJob != null) createdJob.Dispose();
            }
        }

        private static void ControlMain(object state)
        {
            string expectedToken = (string)state;
            uint exitCode = 137;
            try
            {
                string input = Console.In.ReadLine();
                if (input != null && !String.Equals(input, expectedToken, StringComparison.Ordinal))
                {
                    Console.Error.WriteLine("SYNARA_SMOKE_JOB_ERROR invalid shutdown token");
                    Console.Error.Flush();
                    exitCode = 138;
                }
            }
            catch (Exception error)
            {
                Console.Error.WriteLine(
                    "SYNARA_SMOKE_JOB_ERROR shutdown control failed: " + error.Message);
                Console.Error.Flush();
                exitCode = 139;
            }

            if (!TerminateJobObject(jobHandle, exitCode))
            {
                int terminateError = Marshal.GetLastWin32Error();
                Console.Error.WriteLine(
                    "SYNARA_SMOKE_JOB_ERROR TerminateJobObject failed: " + terminateError);
                Console.Error.Flush();
                Environment.Exit(terminateError == 0 ? 140 : terminateError);
            }
            Environment.Exit((int)exitCode);
        }

        public static Task RelayAfterSignal(
            Stream source,
            Stream destination,
            ManualResetEventSlim relaySignal)
        {
            return Task.Factory.StartNew(
                delegate
                {
                    relaySignal.Wait();
                    source.CopyTo(destination);
                    destination.Flush();
                },
                CancellationToken.None,
                TaskCreationOptions.LongRunning,
                TaskScheduler.Default);
        }
    }
}
'@

function ConvertTo-WindowsCommandLineArgument([AllowEmptyString()][string]$Value) {
  if ($Value.Length -gt 0 -and $Value -notmatch '[\s"]') {
    return $Value
  }

  $builder = New-Object Text.StringBuilder
  $backslash = [char]92
  $quote = [char]34
  [void]$builder.Append($quote)
  $backslashCount = 0
  foreach ($character in $Value.ToCharArray()) {
    if ($character -eq $backslash) {
      $backslashCount += 1
      continue
    }
    if ($character -eq $quote) {
      if ($backslashCount -gt 0) {
        [void]$builder.Append($backslash, ($backslashCount * 2))
      }
      [void]$builder.Append($backslash)
      [void]$builder.Append($quote)
      $backslashCount = 0
      continue
    }
    if ($backslashCount -gt 0) {
      [void]$builder.Append($backslash, $backslashCount)
      $backslashCount = 0
    }
    [void]$builder.Append($character)
  }
  if ($backslashCount -gt 0) {
    [void]$builder.Append($backslash, ($backslashCount * 2))
  }
  [void]$builder.Append($quote)
  return $builder.ToString()
}

try {
  Add-Type -TypeDefinition $nativeSource -Language CSharp
  $shutdownToken = "SYNARA_SMOKE_JOB_TERMINATE " + $runId
  [SynaraDesktopSmoke.NativeMethods]::InitializeJobAndControl($shutdownToken)

  $startInfo = New-Object Diagnostics.ProcessStartInfo
  $startInfo.FileName = $executablePath
  $startInfo.UseShellExecute = $false
  $startInfo.CreateNoWindow = $true
  $startInfo.WorkingDirectory = (Get-Location).Path
  $startInfo.RedirectStandardInput = $true
  $startInfo.RedirectStandardOutput = $true
  $startInfo.RedirectStandardError = $true
  if ($childArguments.Count -gt 0) {
    $quotedArguments = @(
      $childArguments | ForEach-Object { ConvertTo-WindowsCommandLineArgument $_ }
    )
    $startInfo.Arguments = $quotedArguments -join " "
  }
  $startInfo.EnvironmentVariables.Remove("SYNARA_SMOKE_JOB_RUN_ID")

  $child = New-Object Diagnostics.Process
  $child.StartInfo = $startInfo
  if (!$child.Start()) {
    throw "Process.Start returned false"
  }
  $child.StandardInput.Close()

  $relaySignal = New-Object Threading.ManualResetEventSlim($false)
  $stdoutTask = [SynaraDesktopSmoke.NativeMethods]::RelayAfterSignal(
    $child.StandardOutput.BaseStream,
    [Console]::OpenStandardOutput(),
    $relaySignal
  )
  $stderrTask = [SynaraDesktopSmoke.NativeMethods]::RelayAfterSignal(
    $child.StandardError.BaseStream,
    [Console]::OpenStandardError(),
    $relaySignal
  )

  [Console]::Out.WriteLine("SYNARA_SMOKE_JOB_READY " + $runId)
  [Console]::Out.Flush()
  $relaySignal.Set()

  $child.WaitForExit()
  $childExitCode = $child.ExitCode
  [Threading.Tasks.Task]::WaitAll(@($stdoutTask, $stderrTask))
  $child.Dispose()
  [Environment]::Exit($childExitCode)
} catch {
  Write-SmokeJobError $_.Exception.Message
}
