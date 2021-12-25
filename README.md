# Ethereum Event Plugin

This plugin reads, parses and ingests events/logs from the Ethereum mainnet for a specific contract address - allowing you to analyze on-chain events in PostHog.

## Configuration

The configuration for the plugin are as follows

**Contract Address**: The address of the contract being monitored

**Contract ABI**: The ABI for the contract being monitored. Uploaded as a JSON file.

**Event Parsing Instructions**: An optional JSON file that describes how events should be parsed before being ingested into PostHog. If an event or argument are not described in this file, it will be parsed using only the information in the ABI. Each argument can be given 2 values:

-   **isDistinctId**: An optional boolean that designates if this field should be duplicated as the event's distinct_id
-   **argType**: An optional string that describes how the value should be parsed. Options are: 'eth', 'number', 'int', 'boolean', 'hex', and 'string'. If no option is provided, we will default to however ethers.js parses the field

Here is an example event parsing JSON object

```
{
    "Transfer": { // Event name as used in the ABI
        "to": { // Name of argument as described in the ABI
            "isDistinctId": true,
        },
        "amount": {
            "argType": "eth",
        }
        ....
    }
    ...
}
```
