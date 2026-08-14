import assert from "node:assert/strict";
import { test } from "node:test";

import {
  compareTokensByServerAndRole,
  getTokenRoleSortValue,
  getTokenServerSortValue,
} from "../src/utils/tokenSort.js";

test("token sorting uses numeric server id before role id", () => {
  const tokens = [
    { id: "c", name: "角色-2-20", server: "10服", roleId: 20 },
    { id: "a", name: "角色-1-300", server: "2服", roleId: 300 },
    { id: "b", name: "角色-1-20", server: "2服", roleId: 20 },
  ];

  tokens.sort(compareTokensByServerAndRole);

  assert.deepEqual(
    tokens.map((token) => token.id),
    ["b", "a", "c"],
  );
});

test("token sorting normalizes encoded server ids and reads role ids from names", () => {
  assert.equal(getTokenServerSortValue({ server: "39服" }), 39);
  assert.equal(getTokenServerSortValue({ serverId: "1000066" }), 66);
  assert.equal(
    getTokenRoleSortValue({ name: "39号战士-0-139076719" }),
    139076719,
  );
});