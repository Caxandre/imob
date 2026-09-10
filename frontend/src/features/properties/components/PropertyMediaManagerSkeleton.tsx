import { Skeleton } from "@/components/ui/skeleton";

// First load only (Prompt 041, section 61) — background polling/refetches never replace the
// grid with this again (section 62), since `usePropertyMedia` keeps serving cached data.
export function PropertyMediaManagerSkeleton() {
  return (
    <div className="grid grid-cols-2 gap-4 sm:grid-cols-3 lg:grid-cols-4">
      {Array.from({ length: 4 }, (_, index) => (
        <Skeleton key={index} className="aspect-square w-full rounded-lg" />
      ))}
    </div>
  );
}
