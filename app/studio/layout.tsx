import { StudioRail } from '@/components/port/StudioRail'

export const metadata = { title: 'ArcStudio — Arcfun' }

export default function PortLayout({ children }: { children: React.ReactNode }) {
  return (
    <>
      <StudioRail />
      <div className="lg:pl-[88px]">{children}</div>
    </>
  )
}
