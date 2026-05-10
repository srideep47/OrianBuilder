import type React from "react";
import type { ReactNode } from "react";
import { ScanQrCode } from "lucide-react";
import {
  OrianBuilderCard,
  OrianBuilderCardHeader,
  OrianBuilderBadge,
} from "./OrianBuilderCardPrimitives";

interface OrianBuilderWebCrawlProps {
  children?: ReactNode;
  node?: any;
}

export const OrianBuilderWebCrawl: React.FC<OrianBuilderWebCrawlProps> = ({
  children,
  node: _node,
}) => {
  return (
    <OrianBuilderCard accentColor="blue">
      <OrianBuilderCardHeader
        icon={<ScanQrCode size={15} />}
        accentColor="blue"
      >
        <OrianBuilderBadge color="blue">Web Crawl</OrianBuilderBadge>
      </OrianBuilderCardHeader>
      {children && (
        <div className="px-3 pb-2 text-sm italic text-muted-foreground">
          {children}
        </div>
      )}
    </OrianBuilderCard>
  );
};
