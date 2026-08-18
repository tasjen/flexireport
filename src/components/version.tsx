import { useQuery } from "@tanstack/react-query";
import { getVersion } from "@tauri-apps/api/app";

import { cn } from "@/lib/utils";

type Props = React.ComponentProps<"span">;
export default function Version({ className, ...props }: Props) {
  const { data: version } = useQuery({
    queryKey: ["version"],
    queryFn: getVersion,
  });

  if (!version) return null;

  return (
    <span className={cn("text-xs text-gray-500", className)} {...props}>
      v{version}
    </span>
  );
}
