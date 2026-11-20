// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

/**
 * LogAnchor — the entire on-chain half of WITNESS.
 *
 * It stores one 32-byte fingerprint per batch and nothing else.
 * No log data, no user data, no personal information ever touches the chain —
 * only the Merkle root, which is a one-way fingerprint.
 *
 * Why this cannot be replaced by a database: the contract is deployed once and
 * its history is replicated by every node on the network. The server operator
 * cannot rewrite an entry here, and neither can an attacker who owns the server.
 * That asymmetry is the whole product.
 */
contract LogAnchor {
    address public immutable owner;
    uint256 public count;

    // seq => published root. Written once, never overwritten.
    mapping(uint256 => bytes32) private roots;
    mapping(uint256 => uint256) private publishedAt;

    event Anchored(uint256 indexed seq, bytes32 root, uint256 timestamp, string org);

    error NotAuthorised();
    error AlreadyAnchored(uint256 seq);

    constructor() {
        owner = msg.sender;
    }

    /// @param seq  batch number, must be new
    /// @param root Merkle root of that batch of log entries
    function anchor(uint256 seq, bytes32 root, string calldata org) external {
        if (msg.sender != owner) revert NotAuthorised();
        if (roots[seq] != bytes32(0)) revert AlreadyAnchored(seq);
        roots[seq] = root;
        publishedAt[seq] = block.timestamp;
        count += 1;
        emit Anchored(seq, root, block.timestamp, org);
    }

    function rootOf(uint256 seq) external view returns (bytes32) {
        return roots[seq];
    }

    function timeOf(uint256 seq) external view returns (uint256) {
        return publishedAt[seq];
    }
}
