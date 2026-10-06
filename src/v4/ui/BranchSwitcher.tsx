export type BranchChoice = { branchId: string; label: string; storyId: string; parentBranchId: string | null };

export function BranchSwitcher({ branches, activeBranchId, disabled, onSwitch }: {
  branches: BranchChoice[];
  activeBranchId: string;
  disabled: boolean;
  onSwitch: (branchId: string) => void;
}) {
  return <label className="v2-field v4-branch-switcher"><span>Story branch</span>
    <select aria-label="Story branch" disabled={disabled} value={activeBranchId} onChange={(event) => onSwitch(event.target.value)}>
      {branches.map((branch) => <option key={branch.branchId} value={branch.branchId}>{branch.label} / {branch.branchId.slice(0, 8)}{branch.parentBranchId ? ' (fork)' : ' (root)'}</option>)}
    </select>
  </label>;
}
