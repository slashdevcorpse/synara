import { FiGitBranch } from "react-icons/fi";

export function SidebarProjectGitActionIndicator({ projectName }: { projectName: string }) {
  const label = `Git operation running for ${projectName}`;
  return (
    <span
      role="status"
      aria-label={label}
      title={label}
      className="inline-flex shrink-0 items-center text-info"
    >
      <FiGitBranch aria-hidden="true" className="size-3 motion-safe:animate-pulse" />
    </span>
  );
}
