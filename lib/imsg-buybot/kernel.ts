/**
 * Kernel v3 (ERC-7579) `execute` callData for a UserOp. Batch mode only, so approve + buy land in
 * one atomic UserOp (the approve can never be left dangling if the buy reverts).
 */
import {
  decodeAbiParameters,
  decodeFunctionData,
  encodeAbiParameters,
  encodeFunctionData,
  type Address,
  type Hex,
} from 'viem'

export type Call = { target: Address; value: bigint; data: Hex }

/** callType 0x01 = batch, execType 0x00 = revert on failure. */
export const KERNEL_EXEC_MODE_BATCH =
  '0x0100000000000000000000000000000000000000000000000000000000000000' as const

export const KERNEL_EXECUTE_ABI = [
  {
    type: 'function',
    name: 'execute',
    stateMutability: 'payable',
    inputs: [
      { name: 'execMode', type: 'bytes32' },
      { name: 'executionCalldata', type: 'bytes' },
    ],
    outputs: [],
  },
] as const

const EXECUTIONS = [
  {
    type: 'tuple[]',
    components: [
      { name: 'target', type: 'address' },
      { name: 'value', type: 'uint256' },
      { name: 'callData', type: 'bytes' },
    ],
  },
] as const

export function encodeKernelBatch(calls: Call[]): Hex {
  const executionCalldata = encodeAbiParameters(EXECUTIONS, [
    calls.map((c) => ({ target: c.target, value: c.value, callData: c.data })),
  ])
  return encodeFunctionData({
    abi: KERNEL_EXECUTE_ABI,
    functionName: 'execute',
    args: [KERNEL_EXEC_MODE_BATCH, executionCalldata],
  })
}

export function decodeKernelBatch(callData: Hex): Call[] {
  const { args } = decodeFunctionData({ abi: KERNEL_EXECUTE_ABI, data: callData })
  if (args[0] !== KERNEL_EXEC_MODE_BATCH) throw new Error(`not a batch execute (mode ${args[0]})`)
  const [executions] = decodeAbiParameters(EXECUTIONS, args[1])
  return executions.map((e) => ({ target: e.target, value: e.value, data: e.callData }))
}
