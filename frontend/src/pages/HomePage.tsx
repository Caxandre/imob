import { Link } from "react-router";

import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Separator } from "@/components/ui/separator";

/**
 * Temporary landing page (this task, section 21) — proves the toolchain (React, Tailwind,
 * shadcn/ui) works end to end. Still no property/tenant data or API call of its own (section
 * 73) — the "Ver imóveis" link (Prompt 037B, section 7) is the only addition, and `/properties`
 * keeps working without a configured tenant on its own (it renders a dedicated state instead).
 */
export function HomePage() {
  return (
    <main className="flex min-h-svh items-center justify-center p-6">
      <Card className="w-full max-w-sm">
        <CardHeader>
          <CardTitle className="text-2xl">Imob</CardTitle>
          <CardDescription>Frontend foundation is ready.</CardDescription>
        </CardHeader>
        <Separator />
        <CardContent className="flex items-center justify-between">
          <Button>shadcn/ui</Button>
          <Badge variant="secondary">ready</Badge>
        </CardContent>
        <Separator />
        <CardContent>
          <Link to="/properties" className="text-sm text-primary underline underline-offset-4">
            Ver imóveis
          </Link>
        </CardContent>
      </Card>
    </main>
  );
}
