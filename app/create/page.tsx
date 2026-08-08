import { ArcCreateForm } from '@/components/ArcCreateForm'

export const metadata = { title: 'Launch a token — ArcFun' }

export default function CreatePage() {
  return (
    <main className="min-h-screen bg-black text-white px-4 pt-28 pb-16">
      <div className="max-w-lg mx-auto mb-8 text-center space-y-2">
        <h1 className="font-[family-name:var(--font-space-grotesk)] text-2xl font-bold">Launch on Arc</h1>
        <p className="text-sm text-gray-500">One transaction. Full supply onto Uniswap V3. LP locked a year.</p>
      </div>
      <ArcCreateForm />
    </main>
  )
}
