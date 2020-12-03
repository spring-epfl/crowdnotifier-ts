import {
    crypto_box_keypair,
    crypto_box_seal,
    crypto_box_seal_open, crypto_hash_sha256,
    crypto_secretbox_easy,
    crypto_secretbox_keygen,
    crypto_secretbox_open_easy,
    from_string,
    IKeyPair,
    randombytes_buf,
    secretbox_nonce,
    to_string,
    waitReady as sodiumWaitReady
} from "../lib/sodium";
import * as mcl from "../lib/mcl";
import {Commitment} from "./proto";

export async function waitReady() {
    await mcl.waitReady();
    await sodiumWaitReady();
}

/**
 * What needs to be stored in the users' phone.
 */
export interface IUserRecord {
    R1: mcl.G2
    Z1: mcl.GT
    R2: mcl.G2
    K: Uint8Array
    c: Uint8Array
    ctxt_nonce: Uint8Array
}

/**
 * This is the secret information of the location.
 */
export interface IMasterTrace {
    mskv: mcl.Fr;
    info: string;
    nonce: Uint8Array;
    mskHAEnc: Uint8Array;
}

/**
 * Things to print on QRcodes - the mtr part only needs to be used when an infection is signaled.
 */
export interface ILocationData {
    // entry information
    ent: mcl.G2;
    // proof for the entry information
    pEnt: Uint8Array;
    // master tracing information for the QRtrace)
    mtr: IMasterTrace;
}

/**
 * The request from the health authority to the location owner to create a proof to be sent to
 * the visitors.
 */
export interface IPreTrace {
    Tprime: mcl.G1
    info: string
    nonce: Uint8Array
    ctxt: Uint8Array
}

/**
 * Section7 implements the cryptographic protocol in section 7 of the CrowdNotifier whitepaper.
 */
export class Section7 {
    /**
     * Setup for the HealthAuthority - returns a keypair that can be used to encrypt the QRtrack codes.
     */
    static setupHA(): IKeyPair {
        return crypto_box_keypair();
    }

    /**
     * Creates the data necessary for a location owner.
     * @param info is the public info of the location, e.g., name:location:room
     * @param pkH the public key of the health authority
     * @return the LocationData to be printed in 2 (3?) QRcodes
     */
    static genCode(info: string, pkH: Uint8Array): ILocationData {
        const mskv = new mcl.Fr();
        mskv.setByCSPRNG();
        const mskHA = new mcl.Fr();
        mskHA.setByCSPRNG();
        const msk = mcl.add(mskv, mskHA);
        const mpk = mcl.mul(Helpers.baseG2(), msk);
        const nonce = randombytes_buf(msk.serialize().byteLength * 2);
        const mskHAEnc = crypto_box_seal(mskHA.serialize(), pkH);
        const mtr = {mskv, info, nonce, mskHAEnc}
        return {ent: mpk, pEnt: nonce, mtr};
    }

    /**
     * Creates a private record for the user to store in her phone.
     * @param ent as presented in the QRentry
     * @param pEnt as presented in the QRentry
     * @param info as presented in the QRentry
     * @param cnt as hours since the unix epoch
     * @param aux free string
     * @return user record to be stored
     */
    static scan(ent: mcl.G2, pEnt: Uint8Array, info: string, cnt: number, aux: string): IUserRecord {
        const mpk = ent;
        const nonce = pEnt;

        const r1 = new mcl.Fr();
        r1.setByCSPRNG();
        const r2 = new mcl.Fr();
        r2.setByCSPRNG();
        const k = crypto_secretbox_keygen();
        const ctxt_nonce = secretbox_nonce();
        const c = crypto_secretbox_easy(from_string(aux), ctxt_nonce, k);

        const R1 = mcl.mul(Helpers.baseG2(), r1);
        const H1inc = this.infoNonceCounter(info, nonce, cnt);
        const Z1 = mcl.pairing(mcl.mul(H1inc, r1), mpk);
        const R2 = mcl.mul(Helpers.baseG2(), r2);
        const Z2 = mcl.pairing(mcl.mul(H1inc, r2), mpk);
        const K = Helpers.xor(k, Helpers.hashT(Z2));

        return {R1, Z1, R2, K, c, ctxt_nonce};
    }

    /**
     * Convenience method to calculate the hash-to-G1 of the info, nonce, and counter.
     * @param info
     * @param nonce
     * @param counter
     */
    static infoNonceCounter(info: string, nonce: Uint8Array, counter: number): mcl.G1 {
        const buf = Commitment.encode(Commitment.create({
            info, nonce, counter
        })).finish();
        return mcl.hashAndMapToG1(buf);
    }

    /**
     * Generates a pre-trace by the location owner, one for every slot of possible infection.
     * @param mtrV master trace record from the location
     * @param cnt hours since the unix epoch
     * @return an IPreTrace for the health authority
     */
    static genPreTrace(mtrV: IMasterTrace, cnt: number): IPreTrace {
        const {info, nonce, mskv, mskHAEnc: ctxt} = mtrV;
        const Tprime = mcl.mul(this.infoNonceCounter(info, nonce, cnt), mskv);
        return {Tprime, info, nonce, ctxt};
    }

    /**
     * Generates an anonymous trace that can only be used by people having scanned the QRentry code
     * @param kpHA the keypair of the health authority
     * @param cnt hours since the unix epoch
     * @param ptr from genPreTrace
     * @param proofPTR is ignored for the moment
     * @return tracing information to be stored
     * @throws an error if it cannot deserialize or cannot decrypt the context.
     */
    static genTrace(kpHA: IKeyPair, cnt: number, ptr: IPreTrace, proofPTR?: Uint8Array): (mcl.G1 | undefined) {
        const {Tprime, info, nonce, ctxt} = ptr;
        const mskHA = new mcl.Fr();
        try {
            mskHA.deserialize(crypto_box_seal_open(ctxt, kpHA.publicKey, kpHA.privateKey));
        } catch (e) {
            console.log("couldn't decrypt or deserialize: " + e);
            return undefined;
        }
        const B = this.infoNonceCounter(info, nonce, cnt);
        return mcl.add(Tprime, mcl.mul(B, mskHA));
    }

    /**
     * Tries to match a user record against a trace.
     * @param rec one of the user records created by scan
     * @param tr one of the traces received by the health authority
     * @return the aux string (if empty will be "") or undefined if no match occurred
     */
    static match(rec: IUserRecord, tr: mcl.G1): (string | undefined) {
        const Z1prime = mcl.pairing(tr, rec.R1);
        if (!Z1prime.isEqual(rec.Z1)) {
            return undefined;
        }
        try {
            const k = Helpers.xor(rec.K, Helpers.hashT(mcl.pairing(tr, rec.R2)));
            // If the decryption fails, it throws an error.
            const aux = crypto_secretbox_open_easy(rec.c, rec.ctxt_nonce, k);
            return to_string(aux);
        } catch (e) {
            console.log("couldn't decrypt: " + e);
            return undefined;
        }
    }
}

/**
 * New methods and definitions
 */
class Helpers {
    // from https://github.com/zcash/librustzcash/blob/6e0364cd42a2b3d2b958a54771ef51a8db79dd29/pairing/src/bls12_381/README.md#generators
    static baseG1(): mcl.G1 {
        const base = new mcl.G1();
        base.mclG1.setStr('1 3685416753713387016781088315183077757961620795782546409894578378688607592378376318836054947676345821548104185464507 1339506544944476473020471379941921221584933875938349620426543736416511423956333506472724655353366534992391756441569')
        return base;
    }

    // from https://github.com/zcash/librustzcash/blob/6e0364cd42a2b3d2b958a54771ef51a8db79dd29/pairing/src/bls12_381/README.md#generators
    static baseG2(): mcl.G2 {
        const base = new mcl.G2();
        base.mclG2.setStr('1 352701069587466618187139116011060144890029952792775240219908644239793785735715026873347600343865175952761926303160 3059144344244213709971259814753781636986470325476647558659373206291635324768958432433509563104347017837885763365758 1985150602287291935568054521177171638300868978215655730859378665066344726373823718423869104263333984641494340347905 927553665492332455747201965776037880757740193453592970025027978793976877002675564980949289727957565575433344219582')
        return base;
    }

    static hashT(gt: mcl.GT): Uint8Array {
        return crypto_hash_sha256(gt.serialize());
    }

    static xor(a: Uint8Array, b: Uint8Array): Uint8Array {
        if (a.length !== b.length) {
            throw new Error("cannot xor two Uint8Arrays of different length");
        }
        const c = new Uint8Array(a.length);
        for (let i = 0; i < a.length; i++) {
            c[i] = a[i]^b[i];
        }
        return c;
    }
}