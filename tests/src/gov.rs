use crate::*;
use lvrt_gov::{accounts as acc, instruction as ins, ProposalAccountMeta};

pub fn config() -> Pubkey {
    pda(&[seeds::CONFIG], &lvrt_gov::ID)
}
pub fn executor() -> Pubkey {
    pda(&[seeds::EXECUTOR], &lvrt_gov::ID)
}
pub fn proposal(id: u64) -> Pubkey {
    pda(&[seeds::PROPOSAL, &id.to_le_bytes()], &lvrt_gov::ID)
}

pub fn initialize(env: &mut Env, admin: Pubkey, guardian: Pubkey) {
    let i = ix(
        lvrt_gov::ID,
        ins::Initialize { admin, guardian, delay_s: lvrt_common::TIMELOCK_DELAY_S },
        acc::Initialize {
            payer: env.deployer.pubkey(),
            config: config(),
            executor: executor(),
            program: lvrt_gov::ID,
            program_data: program_data_address(&lvrt_gov::ID),
            system_program: SYSTEM,
        },
        vec![],
    );
    let d = env.deployer.insecure_clone();
    env.ok(&[i], &[&d]);
}

pub fn queue_ix(admin: &Pubkey, id: u64, target: &Instruction) -> Instruction {
    ix(
        lvrt_gov::ID,
        ins::Queue {
            target_program: target.program_id,
            accounts: target
                .accounts
                .iter()
                .map(|m| ProposalAccountMeta { pubkey: m.pubkey, is_signer: m.is_signer, is_writable: m.is_writable })
                .collect(),
            data: target.data.clone(),
            description_hash: [1; 32],
        },
        acc::Queue { admin: *admin, config: config(), proposal: proposal(id), system_program: SYSTEM },
        vec![],
    )
}

/// The executor signs via `invoke_signed`, never as a transaction signer.
pub fn execute_ix(id: u64, target: &Instruction) -> Instruction {
    let mut rem: Vec<AccountMeta> = target
        .accounts
        .iter()
        .map(|m| AccountMeta { pubkey: m.pubkey, is_signer: false, is_writable: m.is_writable })
        .collect();
    rem.push(AccountMeta::new_readonly(target.program_id, false));
    ix(lvrt_gov::ID, ins::Execute {}, acc::Execute { config: config(), proposal: proposal(id), executor: executor() }, rem)
}

pub fn cancel_ix(signer: &Pubkey, id: u64) -> Instruction {
    ix(lvrt_gov::ID, ins::Cancel {}, acc::Cancel { signer: *signer, config: config(), proposal: proposal(id) }, vec![])
}
