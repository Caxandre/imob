import { Skeleton } from "@/components/ui/skeleton";

const SKELETON_ROWS = 6;

// Shown while the list is still pending (Prompt 044, section 24) — a whole, non-broken table
// shape, not a blank page.
export function LeadsTableSkeleton() {
  return (
    <div className="flex flex-col gap-2 rounded-xl border p-4">
      {Array.from({ length: SKELETON_ROWS }, (_, index) => (
        <Skeleton key={index} className="h-10 w-full" />
      ))}
    </div>
  );
}
