# PNYX PRIVACY POLICY

Last Updated: October 2026

## 1. Who we are

**Pnyx** ("we", "us") means both the mobile app you installed and the service behind it.

This policy explains what reaches us, what reaches others, and what we could not see even if we were asked to.

## 2. Early access

**Pnyx is in open early access.** Anyone can use it, and it is deliberately unfinished: we are shipping it now so that the people using it shape what it becomes.

Core parts of the app may change drastically in response to feedback, and what the app does with data can change with them. When that happens we update this policy and show you the change in the app before it takes effect. Everything below describes the app as it behaves today.

## 3. The short version

- **We never receive your recovery phrase or private keys.** They are generated on your device and held in its secure enclave, gated by your device biometrics or passcode. We cannot recover them, and neither can anyone else.
- **We do not use analytics.** No analytics, attribution, advertising or session-replay component is present in the app, and we do not sell or share personal data for advertising.
- **Crash reporting is switched off.** No crash or error report leaves your device. If that ever changes, this policy will be updated and the change shown to you in the app first.
- **Direct messages are end-to-end encrypted** and we cannot read them.
- **Some things you do are recorded permanently on a public blockchain and can never be deleted.** This is the most important thing in this document; see section 6.

## 4. What we hold

**Your identity.** A Pnyx identity is derived from a recovery phrase on your device. What reaches our service is a commitment — a value derived from your identity that does not reveal it — plus a display name and avatar if you choose them. We do not ask for an email address, a phone number or a real name, and there is no account to register.

**Forum content.** Posts, replies, channel names and community descriptions you write are stored by our service so that others can read them. Treat anything you post as public to that community.

**Direct messages.** Messages are encrypted on your device and our service relays ciphertext it holds no key for. We do, however, store delivery information: which identities a conversation is between, and when messages were sent. We cannot read what you wrote. We can see that you wrote to someone.

**Support correspondence.** If you contact us, we hold what you send us.

## 5. What we do not hold

We do not hold your recovery phrase, private keys, wallet passwords or PINs. We do not hold your funds — Pnyx is non-custodial. We do not receive the contents of your direct messages. We do not build an advertising profile of you, because we run no analytics at all.

The transaction-explanation feature runs a language model on your device. The transaction being explained is not sent to us or to any model provider.

## 6. What is public and permanent on the blockchain

Some of what you do in Pnyx becomes a transaction on a public blockchain. Blockchains are public and append-only. We cannot edit or delete anything recorded on one, and neither can you. Treat it as irreversible before you act.

Recorded on chain: community membership, moderation actions, votes, name registrations, and every wallet transaction you make.

Pnyx is designed so that this reveals as little as possible:

- You join a community under a **persona** that exists only in that community. The chain records that a member joined without recording which identity it was.
- Two of your personas in two different communities cannot be linked to each other.
- Post content, channel names and community descriptions are deliberately **not** put on chain.

The limits are real, and you should assume them:

- A **wallet address is a public identifier.** Anyone who learns an address is yours can see its entire history, past and future. Addresses you publish, or use to prove something to a gated community, may be linkable to you.
- **Names you register are public by design.** That is what they are for.
- **Timing is visible.** Determined analysis of when things happen can sometimes narrow down who did them.

## 7. Other services your device contacts

Pnyx contacts other services in order to work. Each of them sees your IP address and what you asked for. We do not control how they operate, and you should read their own policies.

- **Our own service and configuration hosts.** Forum content, app configuration and the cryptographic files the app needs. These see your IP address, your identity commitment, and what you read.
- **A Cardano blockchain indexer.** Balances and transaction history. It sees the addresses your wallet asks about, tied to your IP address — which is the most revealing of these.
- **A price source.** Converting balances to your chosen currency.
- **Token metadata and icon hosts.** Images shown in asset lists, which reveal which assets you hold or view.
- **IPFS and Arweave gateways.** NFT media that is not available elsewhere, which reveals which item you are viewing.
- **A swap provider.** Quotes and orders, when you swap. It sees the details of the swap and your IP address.
- **Google Firebase Cloud Messaging.** Push notifications, using a device token. Notification contents carry no message text and no conversation identifier.
- **Apple and Google platform services.** Passkeys, the secure enclave and app delivery, under their own policies.
- **Google Block Store, on Android.** Syncing your passkey-protected recovery blob if you turn that on. It receives encrypted bytes it holds no key for.

If you connect a third-party app, or use a hardware wallet, those parties see what you send them.

## 8. On your device

Settings, cached balances, forum content you have read and your encrypted keys stay on your device. Uninstalling the app removes them. Uninstalling does not remove anything already written to a blockchain, and does not by itself remove content you posted to a community.

## 9. Your rights

You can ask us what we hold that is associated with your identity, ask us to correct it, ask us to delete it, or object to how we use it. Where a request concerns data recorded on a public blockchain, we will explain what we can and cannot do — nobody is able to delete it, including us.

To make a request, ask in the Pnyx support community; see section 12.

## 10. Test networks

Your Pnyx identity, your communities, and the posts, votes and memberships in them run on **test networks**, and are expected to be deleted when that part of Pnyx moves to a main network. Treat what you create there as disposable.

This does not apply to your funds wallets. Those can be connected to real networks, where balances and transactions are real and permanent. Which network a wallet uses is shown in the app and chosen by you.

## 11. Changes

We will update this policy as the app changes, and during early access we expect to. Material changes will be shown to you in the app and you will be asked to review them. The date at the top always reflects the current version.

## 12. Contact

Support happens inside the app: ask in the Pnyx support community. We will never contact you first, and we will never ask for your recovery phrase. Anyone who does is attacking you.
