import { Skeleton } from "@/components/ui/skeleton";

export function PropertyGallerySkeleton() {
  return (
    <div className="flex flex-col gap-3">
      <Skeleton className="aspect-4/3 w-full rounded-xl" />
      <div className="flex gap-2">
        {Array.from({ length: 4 }, (_, index) => (
          <Skeleton key={index} className="aspect-square w-16 shrink-0 rounded-md" />
        ))}
      </div>
    </div>
  );
}
