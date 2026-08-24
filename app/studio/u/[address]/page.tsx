import { StudioProfileView } from '@/components/port/StudioProfileView'

export const dynamic = 'force-dynamic'

export default async function StudioUserPage({
  params,
}: {
  params: Promise<{ address: string }> | { address: string }
}) {
  const { address } = await Promise.resolve(params)
  return (
    <main className="min-h-screen pt-16 text-white">
      <StudioProfileView address={address} />
    </main>
  )
}
