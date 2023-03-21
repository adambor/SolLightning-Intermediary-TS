export const programIdl = {
    "version": "0.1.0",
    "name": "btc_relay",
    "instructions": [
        {
            "name": "initialize",
            "accounts": [
                {
                    "name": "signer",
                    "isMut": true,
                    "isSigner": true
                },
                {
                    "name": "mainState",
                    "isMut": true,
                    "isSigner": false
                },
                {
                    "name": "headerTopic",
                    "isMut": false,
                    "isSigner": false
                },
                {
                    "name": "systemProgram",
                    "isMut": false,
                    "isSigner": false
                }
            ],
            "args": [
                {
                    "name": "data",
                    "type": {
                        "defined": "BlockHeader"
                    }
                },
                {
                    "name": "blockHeight",
                    "type": "u32"
                },
                {
                    "name": "chainWork",
                    "type": {
                        "array": [
                            "u8",
                            32
                        ]
                    }
                },
                {
                    "name": "lastDiffAdjustment",
                    "type": "u32"
                },
                {
                    "name": "prevBlockTimestamps",
                    "type": {
                        "array": [
                            "u32",
                            10
                        ]
                    }
                }
            ]
        },
        {
            "name": "submitBlockHeaders",
            "accounts": [
                {
                    "name": "signer",
                    "isMut": true,
                    "isSigner": true
                },
                {
                    "name": "mainState",
                    "isMut": true,
                    "isSigner": false
                }
            ],
            "args": [
                {
                    "name": "data",
                    "type": {
                        "vec": {
                            "defined": "BlockHeader"
                        }
                    }
                },
                {
                    "name": "commitedHeader",
                    "type": {
                        "defined": "CommittedBlockHeader"
                    }
                }
            ]
        },
        {
            "name": "submitShortForkHeaders",
            "accounts": [
                {
                    "name": "signer",
                    "isMut": true,
                    "isSigner": true
                },
                {
                    "name": "mainState",
                    "isMut": true,
                    "isSigner": false
                }
            ],
            "args": [
                {
                    "name": "data",
                    "type": {
                        "vec": {
                            "defined": "BlockHeader"
                        }
                    }
                },
                {
                    "name": "commitedHeader",
                    "type": {
                        "defined": "CommittedBlockHeader"
                    }
                }
            ]
        },
        {
            "name": "submitForkHeaders",
            "accounts": [
                {
                    "name": "signer",
                    "isMut": true,
                    "isSigner": true
                },
                {
                    "name": "mainState",
                    "isMut": true,
                    "isSigner": false
                },
                {
                    "name": "forkState",
                    "isMut": true,
                    "isSigner": false
                },
                {
                    "name": "systemProgram",
                    "isMut": false,
                    "isSigner": false
                }
            ],
            "args": [
                {
                    "name": "data",
                    "type": {
                        "vec": {
                            "defined": "BlockHeader"
                        }
                    }
                },
                {
                    "name": "commitedHeader",
                    "type": {
                        "defined": "CommittedBlockHeader"
                    }
                },
                {
                    "name": "forkId",
                    "type": "u64"
                },
                {
                    "name": "init",
                    "type": "bool"
                }
            ]
        },
        {
            "name": "closeForkAccount",
            "accounts": [
                {
                    "name": "signer",
                    "isMut": true,
                    "isSigner": true
                },
                {
                    "name": "forkState",
                    "isMut": true,
                    "isSigner": false
                },
                {
                    "name": "systemProgram",
                    "isMut": false,
                    "isSigner": false
                }
            ],
            "args": [
                {
                    "name": "forkId",
                    "type": "u64"
                }
            ]
        },
        {
            "name": "verifyTransaction",
            "accounts": [
                {
                    "name": "signer",
                    "isMut": true,
                    "isSigner": true
                },
                {
                    "name": "mainState",
                    "isMut": true,
                    "isSigner": false
                }
            ],
            "args": [
                {
                    "name": "reversedTxid",
                    "type": {
                        "array": [
                            "u8",
                            32
                        ]
                    }
                },
                {
                    "name": "confirmations",
                    "type": "u32"
                },
                {
                    "name": "txIndex",
                    "type": "u32"
                },
                {
                    "name": "reversedMerkleProof",
                    "type": {
                        "vec": {
                            "array": [
                                "u8",
                                32
                            ]
                        }
                    }
                },
                {
                    "name": "commitedHeader",
                    "type": {
                        "defined": "CommittedBlockHeader"
                    }
                }
            ]
        },
        {
            "name": "blockHeight",
            "accounts": [
                {
                    "name": "signer",
                    "isMut": true,
                    "isSigner": true
                },
                {
                    "name": "mainState",
                    "isMut": true,
                    "isSigner": false
                }
            ],
            "args": [
                {
                    "name": "value",
                    "type": "u32"
                },
                {
                    "name": "operation",
                    "type": "u32"
                }
            ]
        }
    ],
    "accounts": [
        {
            "name": "MainState",
            "type": {
                "kind": "struct",
                "fields": [
                    {
                        "name": "startHeight",
                        "type": "u32"
                    },
                    {
                        "name": "lastDiffAdjustment",
                        "type": "u32"
                    },
                    {
                        "name": "blockHeight",
                        "type": "u32"
                    },
                    {
                        "name": "totalBlocks",
                        "type": "u32"
                    },
                    {
                        "name": "forkCounter",
                        "type": "u64"
                    },
                    {
                        "name": "tipCommitHash",
                        "type": {
                            "array": [
                                "u8",
                                32
                            ]
                        }
                    },
                    {
                        "name": "tipBlockHash",
                        "type": {
                            "array": [
                                "u8",
                                32
                            ]
                        }
                    },
                    {
                        "name": "chainWork",
                        "type": {
                            "array": [
                                "u8",
                                32
                            ]
                        }
                    },
                    {
                        "name": "blockCommitments",
                        "type": {
                            "array": [
                                {
                                    "array": [
                                        "u8",
                                        32
                                    ]
                                },
                                250
                            ]
                        }
                    }
                ]
            }
        },
        {
            "name": "ForkState",
            "type": {
                "kind": "struct",
                "fields": [
                    {
                        "name": "initialized",
                        "type": "u32"
                    },
                    {
                        "name": "startHeight",
                        "type": "u32"
                    },
                    {
                        "name": "length",
                        "type": "u32"
                    },
                    {
                        "name": "tipCommitHash",
                        "type": {
                            "array": [
                                "u8",
                                32
                            ]
                        }
                    },
                    {
                        "name": "tipBlockHash",
                        "type": {
                            "array": [
                                "u8",
                                32
                            ]
                        }
                    },
                    {
                        "name": "blockCommitments",
                        "type": {
                            "array": [
                                {
                                    "array": [
                                        "u8",
                                        32
                                    ]
                                },
                                250
                            ]
                        }
                    }
                ]
            }
        }
    ],
    "types": [
        {
            "name": "BlockHeader",
            "type": {
                "kind": "struct",
                "fields": [
                    {
                        "name": "version",
                        "type": "u32"
                    },
                    {
                        "name": "reversedPrevBlockhash",
                        "type": {
                            "array": [
                                "u8",
                                32
                            ]
                        }
                    },
                    {
                        "name": "merkleRoot",
                        "type": {
                            "array": [
                                "u8",
                                32
                            ]
                        }
                    },
                    {
                        "name": "timestamp",
                        "type": "u32"
                    },
                    {
                        "name": "nbits",
                        "type": "u32"
                    },
                    {
                        "name": "nonce",
                        "type": "u32"
                    }
                ]
            }
        },
        {
            "name": "CommittedBlockHeader",
            "type": {
                "kind": "struct",
                "fields": [
                    {
                        "name": "chainWork",
                        "type": {
                            "array": [
                                "u8",
                                32
                            ]
                        }
                    },
                    {
                        "name": "header",
                        "type": {
                            "defined": "BlockHeader"
                        }
                    },
                    {
                        "name": "lastDiffAdjustment",
                        "type": "u32"
                    },
                    {
                        "name": "blockheight",
                        "type": "u32"
                    },
                    {
                        "name": "prevBlockTimestamps",
                        "type": {
                            "array": [
                                "u32",
                                10
                            ]
                        }
                    }
                ]
            }
        }
    ],
    "events": [
        {
            "name": "StoreHeader",
            "fields": [
                {
                    "name": "blockHash",
                    "type": {
                        "array": [
                            "u8",
                            32
                        ]
                    },
                    "index": false
                },
                {
                    "name": "commitHash",
                    "type": {
                        "array": [
                            "u8",
                            32
                        ]
                    },
                    "index": false
                },
                {
                    "name": "header",
                    "type": {
                        "defined": "CommittedBlockHeader"
                    },
                    "index": false
                }
            ]
        },
        {
            "name": "StoreFork",
            "fields": [
                {
                    "name": "forkId",
                    "type": "u64",
                    "index": false
                },
                {
                    "name": "blockHash",
                    "type": {
                        "array": [
                            "u8",
                            32
                        ]
                    },
                    "index": false
                },
                {
                    "name": "commitHash",
                    "type": {
                        "array": [
                            "u8",
                            32
                        ]
                    },
                    "index": false
                },
                {
                    "name": "header",
                    "type": {
                        "defined": "CommittedBlockHeader"
                    },
                    "index": false
                }
            ]
        },
        {
            "name": "ChainReorg",
            "fields": [
                {
                    "name": "forkId",
                    "type": "u64",
                    "index": false
                },
                {
                    "name": "startHeight",
                    "type": "u32",
                    "index": false
                },
                {
                    "name": "tipBlockHash",
                    "type": {
                        "array": [
                            "u8",
                            32
                        ]
                    },
                    "index": false
                },
                {
                    "name": "tipCommitHash",
                    "type": {
                        "array": [
                            "u8",
                            32
                        ]
                    },
                    "index": false
                }
            ]
        }
    ],
    "errors": [
        {
            "code": 6000,
            "name": "PrevBlockCommitment",
            "msg": "Invalid previous block commitment."
        },
        {
            "code": 6001,
            "name": "PrevBlock",
            "msg": "Invalid previous block."
        },
        {
            "code": 6002,
            "name": "ErrDiffTarget",
            "msg": "Invalid difficulty target."
        },
        {
            "code": 6003,
            "name": "ErrPowToolow",
            "msg": "PoW too low."
        },
        {
            "code": 6004,
            "name": "ErrTimestampToolow",
            "msg": "Timestamp too low."
        },
        {
            "code": 6005,
            "name": "ErrTimestampTooHigh",
            "msg": "Timestamp too high."
        },
        {
            "code": 6006,
            "name": "InvalidHeaderTopic",
            "msg": "Invalid header topic specified in accounts."
        },
        {
            "code": 6007,
            "name": "NoHeaders",
            "msg": "No headers supplied"
        },
        {
            "code": 6008,
            "name": "ForkTooShort",
            "msg": "Fork too short to become main chains"
        },
        {
            "code": 6009,
            "name": "ErrInit",
            "msg": "Fork initialization error"
        },
        {
            "code": 6010,
            "name": "BlockConfirmations",
            "msg": "Block doesn't have required number of confirmations"
        },
        {
            "code": 6011,
            "name": "MerkleRoot",
            "msg": "Invalid merkle root"
        },
        {
            "code": 6012,
            "name": "InvalidBlockheight",
            "msg": "Blockheight doesn't match"
        }
    ],
    "metadata": {
        "address": "8DMFpUfCk8KPkNLtE25XHuCSsT1GqYxuLdGzu59QK3Rt"
    }
};