import { Interface, ParamType } from '@ethersproject/abi'
import { InfuraProvider } from '@ethersproject/providers'
import { StorageExtension } from '@posthog/plugin-scaffold'
import { BigNumber, Contract, ethers } from 'ethers'
import { boolean } from 'yargs'

const STORAGE_KEY_LAST_INGESTED_BLOCK_NUMBER = 'ethereum-events-plugin-lastIngestedBlockNumber'

type ArgTypes = 'eth' | 'number' | 'string'
type EventName = string
type ArgName = string
interface ArgInstruction {
    isDistinctId?: boolean
    argType: ArgTypes
}
type EventParsingInstruction = Record<EventName, Record<ArgName, ArgInstruction>>

interface Global {
    provider: InfuraProvider
    blockNumberToIngestFrom: number
    contract: Contract
    contractInterface: Interface
    eventParsingInstructions: EventParsingInstruction
}
interface Config {
    eventParsingInstructions: string
    contractAddress: string
}

// Parses data from ethers log objects
// Ethers has a .parseLog function built in, but it uses Object.freeze()
// And Object.freeze is not supported by VM2, so it won't run on the plugin
// server. This function does basically the same thing.
const parseLog = (contractInterface: Interface, log) => {
    var fragment = contractInterface.getEvent(log.topics[0])
    if (!fragment || fragment.anonymous) {
        return null
    }

    // Hack to get the named args. ethers kind of abuses the JS array
    // and decodeEventLog returns an array with named keys. This grabs
    // only the named keys. Let's hope no named keys resolve to be ints...
    const args = { ...contractInterface.decodeEventLog(fragment, log.data, log.topics) }
    const namedArgs = {}
    Object.keys(args).forEach((key) => {
        if (isNaN(parseInt(key))) {
            if (BigNumber.isBigNumber(args[key])) {
                namedArgs[key] = args[key].toHexString()
            } else {
                namedArgs[key] = args[key]
            }
        }
    })

    return {
        eventFragment: fragment,
        name: fragment.name,
        signature: fragment.format(),
        namedArgs: namedArgs,
    }
}

const getLastIngestedBlockNumber = async (storage: StorageExtension): Promise<number | null> => {
    return (await storage.get(STORAGE_KEY_LAST_INGESTED_BLOCK_NUMBER, null)) as number | null
}

const setLastIngestedBlockNumber = async (storage: StorageExtension, blockNumber: number): Promise<void> => {
    return storage.set(STORAGE_KEY_LAST_INGESTED_BLOCK_NUMBER, blockNumber)
}

export const setupPlugin = async (meta) => {
    const global: Partial<Global> = meta.global
    const config: Config = meta.config
    const attachments = meta.attachments

    if (!config.contractAddress) {
        throw new Error('Contract address not provided!')
    }
    if (!attachments.contractABI) {
        throw new Error('Contract ABI not provided!')
    }
    if (attachments.eventParsingInstructions) {
        global.eventParsingInstructions = JSON.parse(
            attachments.eventParsingInstructions.contents.toString()
        ) as EventParsingInstruction
    }

    // TODO: Allow users to add an Infura api key if rate limits are an issue
    global.provider = new ethers.providers.InfuraProvider()

    const contractABI = JSON.parse(attachments.contractABI.contents.toString())
    global.contract = new ethers.Contract(config.contractAddress, contractABI, global.provider)
    global.contractInterface = new ethers.utils.Interface(contractABI)
}

export const runEveryMinute = async (meta) => {
    const global: Global = meta.global
    const config: Config = meta.config
    const storage: StorageExtension = meta.storage

    // Cache for block timestamps
    const blockTimestamps = {}

    const provider = global.provider as InfuraProvider

    const latestBlockNumber = await provider.getBlockNumber()

    // Gets the last ingested block time from the plugin's storage.
    const lastIngestedBlockNumber = (await getLastIngestedBlockNumber(storage)) ?? latestBlockNumber

    // Cap the max number of blocks to look back at 1000 blocks.
    // Right now, the ethereum block time is about 13 seconds, so this is ~3.5 hours.
    // Querying too many blocks can get us rate limited, so if we want to increase this, it probably
    // makes sense to paginate it and add Infura API keys. But because this function runs every minute,
    // we shouldn't be hitting this limit unless the plugin goes down.
    if (latestBlockNumber - lastIngestedBlockNumber > 1000) {
        console.warn(
            `Last parsed block (${lastIngestedBlockNumber}) was more than 1000 blocks behind the current block (${latestBlockNumber}), and we only look back 1000, so some events will be missing.`
        )
        global.blockNumberToIngestFrom = latestBlockNumber - 1000
    }

    const logs = await provider.getLogs({
        address: config.contractAddress,
        fromBlock: global.blockNumberToIngestFrom,
        toBlock: latestBlockNumber,
    })
    for (let log of logs) {
        // Get the block timestamp from the cache or fetch it
        let blockTimestamp
        if (log.blockHash in blockTimestamps) {
            blockTimestamp = blockTimestamps[log.blockHash]
        } else {
            const block = await provider.getBlock(log.blockHash)
            blockTimestamp = block.timestamp
            blockTimestamps[log.blockHash] = blockTimestamp
        }

        try {
            const parsedLog = parseLog(global.contractInterface, log)
            const eventData = {
                $timestamp: blockTimestamp,
                blockNumber: log.blockNumber,
                blockHash: log.blockHash,
                ...parsedLog.namedArgs,
            }

            // Use eventDescription to parse fields
            if (global.eventParsingInstructions) {
                const eventParsingInstructions = global.eventParsingInstructions as EventParsingInstruction
                if (parsedLog.name in eventParsingInstructions) {
                    const eventParsingInstruction = eventParsingInstructions[parsedLog.name]
                    Object.keys(parsedLog.namedArgs).forEach((argName) => {
                        if (argName in eventParsingInstruction) {
                            const argInstruction = eventParsingInstruction[argName]
                            let argValue = parsedLog.namedArgs[argName]
                            if (argInstruction.argType) {
                                if (argInstruction.argType === 'eth') {
                                    argValue = ethers.utils.formatEther(BigNumber.from(argValue))
                                } else if (argInstruction.argType === 'string') {
                                    argValue = ethers.utils.parseBytes32String(argValue)
                                } else if (argInstruction.argType === 'number') {
                                    argValue = BigNumber.from(argValue).toNumber()
                                }
                            }
                            if (argInstruction.isDistinctId) {
                                eventData['distinct_id'] = argValue
                            }
                            eventData[argName] = argValue
                        }
                    })
                }
            }
            posthog.capture(parsedLog.name, eventData)
        } catch (error) {
            console.error("Couldn't parse log: ", error)
        }
    }
    setLastIngestedBlockNumber(storage, latestBlockNumber)
}
