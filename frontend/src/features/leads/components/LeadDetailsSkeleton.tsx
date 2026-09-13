import { Skeleton } from "@/components/ui/skeleton";

// Shown only while the lead itself is still pending — a whole, non-broken layout, same
// convention as `PropertyDetailsSkeleton`.
export function LeadDetailsSkeleton() {
  return (
    <main className="mx-auto flex max-w-3xl flex-col gap-6 p-6">
      <Skeleton className="h-9 w-40" />
      <div className="flex flex-col gap-3">
        <Skeleton className="h-6 w-1/3" />
        <Skeleton className="h-8 w-2/3" />
        <Skeleton className="h-5 w-1/2" />
        <Skeleton className="h-5 w-1/2" />
        <Skeleton className="h-24 w-full" />
      </div>
    </main>
  );
}
