import {
  generateRegistrationOptions as generateRegOptions,
  verifyRegistrationResponse,
  generateAuthenticationOptions as generateAuthOptions,
  verifyAuthenticationResponse,
  VerifiedRegistrationResponse,
  VerifiedAuthenticationResponse,
} from '@simplewebauthn/server';
import type {
  GenerateRegistrationOptionsOpts,
  GenerateAuthenticationOptionsOpts,
  VerifyRegistrationResponseOpts,
  VerifyAuthenticationResponseOpts,
  AuthenticatorTransportFuture,
  RegistrationResponseJSON,
  AuthenticationResponseJSON,
  // The actual type for verification.registrationInfo is RegistrationInfo within @simplewebauthn/server
  // and for verification.authenticationInfo is AuthenticationInfo.
  // We will rely on TypeScript's inference from the VerifiedRegistrationResponse/VerifiedAuthenticationResponse types.
} from '@simplewebauthn/server';
import { passkeyRepository, Passkey, NewPasskey } from '../repositories/passkey.repository';
import { userRepository, User } from '../repositories/user.repository';
import { config } from '../config/app.config';

const RP_ID = config.rpId;
const RP_ORIGIN = config.rpOrigin;
const RP_NAME = config.appName;

const textEncoder = new TextEncoder();

function base64UrlToUint8Array(base64urlString: string): Uint8Array {
  const base64 = base64urlString.replace(/-/g, '+').replace(/_/g, '/');
  // Buffer.from will handle padding correctly for base64
  try {
    return Buffer.from(base64, 'base64');
  } catch (e) {
    console.error("Failed to decode base64url string to Buffer:", base64urlString, e);
    throw new Error("Invalid base64url string for Buffer conversion");
  }
}

export class PasskeyService {
  constructor(
    private passkeyRepo: typeof passkeyRepository,
    private userRepo: typeof userRepository
  ) {}

  async generateRegistrationOptions(username: string, userId: number) {
    const user = await this.userRepo.findUserById(userId);
    if (!user || user.username !== username) {
      throw new Error('User not found or username mismatch');
    }

    const existingPasskeys = await this.passkeyRepo.getPasskeysByUserId(userId);

    const excludeCredentials: {id: string, type: 'public-key', transports?: AuthenticatorTransportFuture[]}[] = existingPasskeys.map(pk => ({
      id: pk.credential_id,
      type: 'public-key',
      transports: pk.transports ? JSON.parse(pk.transports) as AuthenticatorTransportFuture[] : undefined,
    }));

    const options: GenerateRegistrationOptionsOpts = {
      rpName: RP_NAME,
      rpID: RP_ID,
      userID: textEncoder.encode(userId.toString()),
      userName: username,
      userDisplayName: username,
      timeout: 60000,
      attestationType: 'none',
      excludeCredentials,
      authenticatorSelection: {
        residentKey: 'preferred',
        userVerification: 'preferred',
      },
      supportedAlgorithmIDs: [-7, -257],
    };

    const generatedOptions = await generateRegOptions(options);
    return generatedOptions;
  }

  async verifyRegistration(
    registrationResponseJSON: RegistrationResponseJSON,
    expectedChallenge: string,
    userHandleFromClient: string
  ): Promise<VerifiedRegistrationResponse & { newPasskeyToSave?: NewPasskey }> {
    const userId = parseInt(userHandleFromClient, 10);
    if (isNaN(userId)) {
        throw new Error('Invalid user handle provided.');
    }
    const user = await this.userRepo.findUserById(userId);
    if (!user) {
        throw new Error('User not found for the provided handle.');
    }

    // The actual WebAuthn response is nested within the received object
    const actualRegistrationResponse = (registrationResponseJSON as any).registrationResponse;

    // Add a check for the presence of credential ID before calling the library
    if (!actualRegistrationResponse || !actualRegistrationResponse.id) {
      console.error('Missing credential ID in actualRegistrationResponse from client:', registrationResponseJSON);
      throw new Error('Registration failed: Missing or malformed credential ID from client.');
    }

    const verifyOpts: VerifyRegistrationResponseOpts = {
      response: actualRegistrationResponse, // Use the nested object
      expectedChallenge,
      expectedOrigin: RP_ORIGIN,
      expectedRPID: RP_ID,
      requireUserVerification: true,
    };

    const verification = await verifyRegistrationResponse(verifyOpts);

    if (verification.verified && verification.registrationInfo) {
      const regInfo = verification.registrationInfo; 
      
      // Based on the logs, credentialPublicKey, credentialID, counter, and transports
      // are nested within regInfo.credential.
      // credentialBackedUp is at the top level of regInfo.
      const credentialDetails = (regInfo as any).credential;
      const credentialBackedUp = (regInfo as any).credentialBackedUp; // This seems to be at the top level

      if (!credentialDetails || typeof credentialDetails.publicKey !== 'object' || typeof credentialDetails.id !== 'string' || typeof credentialDetails.counter !== 'number') {
        console.error('Verification successful, but registrationInfo.credential structure is unexpected or missing:', regInfo);
        throw new Error('Failed to process registration info due to unexpected credential structure.');
      }

      const credentialPublicKey = credentialDetails.publicKey;
      const credentialID = credentialDetails.id;
      const counter = credentialDetails.counter;
      const transports = credentialDetails.transports; // This might be undefined, handle appropriately
      
      const publicKeyBase64 = Buffer.from(credentialPublicKey).toString('base64');

      const newPasskeyEntry: NewPasskey = {
        user_id: user.id,
        credential_id: credentialID,
        public_key: publicKeyBase64,
        counter: counter,
        transports: transports ? JSON.stringify(transports) : null,
        backed_up: !!credentialBackedUp,
      };
      return { ...verification, newPasskeyToSave: newPasskeyEntry };
    }
    return verification;
  }

  async generateAuthenticationOptions(username?: string) {
    let allowCredentials: {id: string, type: 'public-key', transports?: AuthenticatorTransportFuture[]}[] | undefined = undefined;

    if (username) {
      const user = await this.userRepo.findUserByUsername(username);
      if (user) {
        const userPasskeys = await this.passkeyRepo.getPasskeysByUserId(user.id);
        allowCredentials = userPasskeys.map(pk => ({
          id: pk.credential_id,
          type: 'public-key',
          transports: pk.transports ? JSON.parse(pk.transports) as AuthenticatorTransportFuture[] : undefined,
        }));
      }
    }

    const options: GenerateAuthenticationOptionsOpts = {
      rpID: RP_ID,
      timeout: 60000,
      allowCredentials,
      userVerification: 'preferred',
    };

    const generatedOptions = await generateAuthOptions(options);
    return generatedOptions;
  }

  async verifyAuthentication(
    authenticationResponseJSON: AuthenticationResponseJSON,
    expectedChallenge: string
  ): Promise<VerifiedAuthenticationResponse & { passkey?: Passkey, userId?: number }> {
    
    console.log('[PasskeyService] Verifying authentication. Client response:', JSON.stringify(authenticationResponseJSON, null, 2));
    console.log('[PasskeyService] Expected challenge:', expectedChallenge);

    // Decode and check authenticatorData length
    if (authenticationResponseJSON.response && authenticationResponseJSON.response.authenticatorData) {
      try {
        const authenticatorDataBytes = base64UrlToUint8Array(authenticationResponseJSON.response.authenticatorData);
        console.log(`[PasskeyService] Decoded authenticatorData length: ${authenticatorDataBytes.length} bytes.`);
        if (authenticatorDataBytes.length < 37) {
          console.warn(`[PasskeyService] WARNING: Decoded authenticatorData length (${authenticatorDataBytes.length} bytes) is less than the expected minimum of 37 bytes. This may lead to CBOR parsing errors and subsequent failures (e.g., 'cannot read counter').`);
        }
      } catch (e: any) {
        console.error('[PasskeyService] Error decoding authenticatorData from client response:', e.message);
        // Potentially re-throw or handle as a critical error, as this is unexpected.
      }
    } else {
      console.warn('[PasskeyService] authenticatorData is missing in the client response.');
    }

    const credentialIdFromResponse = authenticationResponseJSON.id;
    if (!credentialIdFromResponse) {
        console.error('[PasskeyService] Credential ID missing from authentication response.');
        throw new Error('Credential ID missing from authentication response.');
    }
    console.log('[PasskeyService] Credential ID from response:', credentialIdFromResponse);

    const passkey = await this.passkeyRepo.getPasskeyByCredentialId(credentialIdFromResponse);
    if (!passkey) {
      console.error('[PasskeyService] Passkey not found for credential ID:', credentialIdFromResponse);
      throw new Error('Authentication failed. Passkey not found.');
    }
    console.log('[PasskeyService] Passkey from DB:', JSON.stringify(passkey, null, 2));

    let authenticatorCredentialID: Uint8Array;
    try {
        authenticatorCredentialID = base64UrlToUint8Array(passkey.credential_id);
    } catch (e: any) {
        console.error('[PasskeyService] Error decoding credential_id to Uint8Array:', passkey.credential_id, e.message);
        throw new Error('Failed to decode credential_id.');
    }

    let authenticatorPublicKey: Uint8Array; // Changed type from Buffer to Uint8Array
    try {
        const pkBuffer = Buffer.from(passkey.public_key, 'base64');
        // Ensure it's a plain Uint8Array instance
        authenticatorPublicKey = new Uint8Array(pkBuffer.buffer, pkBuffer.byteOffset, pkBuffer.byteLength);
    } catch (e: any) {
        console.error('[PasskeyService] Error decoding public_key to Uint8Array:', passkey.public_key, e.message);
        throw new Error('Failed to decode public_key.');
    }
    
    let authenticatorTransports: AuthenticatorTransportFuture[] | undefined;
    try {
        authenticatorTransports = passkey.transports ? JSON.parse(passkey.transports) as AuthenticatorTransportFuture[] : undefined;
    } catch (e: any) {
        console.error('[PasskeyService] Error parsing transports JSON:', passkey.transports, e.message);
        authenticatorTransports = undefined;
    }

    const authenticatorObject = {
      credentialID: authenticatorCredentialID,
      credentialPublicKey: authenticatorPublicKey,
      counter: passkey.counter,
      transports: authenticatorTransports,
      credentialBackedUp: !!passkey.backed_up,
      // Ensure credentialDeviceType is one of the allowed string literals
      credentialDeviceType: (passkey.backed_up ? 'multiDevice' : 'singleDevice') as 'multiDevice' | 'singleDevice',
    };

    console.log('[PasskeyService] Authenticator object to be used for verification:');
    console.log(`  - credentialID (type: ${typeof authenticatorObject.credentialID}, instanceof Uint8Array: ${authenticatorObject.credentialID instanceof Uint8Array}, length: ${authenticatorObject.credentialID?.length}):`, authenticatorObject.credentialID);
    console.log(`  - credentialPublicKey (type: ${typeof authenticatorObject.credentialPublicKey}, instanceof Uint8Array: ${authenticatorObject.credentialPublicKey instanceof Uint8Array}, instanceof Buffer: ${authenticatorObject.credentialPublicKey instanceof Buffer}, length: ${authenticatorObject.credentialPublicKey?.length}):`, authenticatorObject.credentialPublicKey);
    console.log(`  - counter (type: ${typeof authenticatorObject.counter}):`, authenticatorObject.counter);
    console.log(`  - transports (type: ${typeof authenticatorObject.transports}):`, authenticatorObject.transports);
    console.log(`  - credentialBackedUp (type: ${typeof authenticatorObject.credentialBackedUp}):`, authenticatorObject.credentialBackedUp);
    console.log(`  - credentialDeviceType (type: ${typeof authenticatorObject.credentialDeviceType}):`, authenticatorObject.credentialDeviceType);
    
    // Reverting to 'any' for verifyOpts due to issues with the library's
    // type definitions for VerifyAuthenticationResponseOpts not recognizing 'authenticator' key.
    // This aligns with the original code's approach and TODO comment.
    const verifyOpts: any = {
      response: authenticationResponseJSON,
      expectedChallenge,
      expectedOrigin: RP_ORIGIN,
      expectedRPID: RP_ID,
      authenticator: authenticatorObject,
      requireUserVerification: true,
    };
    console.log('[PasskeyService] verifyOpts to be passed to @simplewebauthn/server (using type any):', JSON.stringify(verifyOpts, (key, value) => {
        if (value instanceof Uint8Array || value instanceof Buffer) {
            // Represent Uint8Array/Buffer as a string indicating its type and length for cleaner logs
            return `[${value instanceof Buffer ? 'Buffer' : 'Uint8Array'} len:${value.length}]`;
        }
        return value;
    }, 2));

    // Call without 'as VerifyAuthenticationResponseOpts' since verifyOpts is 'any'
    const verification = await verifyAuthenticationResponse(verifyOpts);

    if (verification.verified && verification.authenticationInfo) {
      const authInfo = verification.authenticationInfo;
      await this.passkeyRepo.updatePasskeyCounter(passkey.credential_id, authInfo.newCounter);
      await this.passkeyRepo.updatePasskeyLastUsedAt(passkey.credential_id);
      return { ...verification, passkey, userId: passkey.user_id };
    }
    throw new Error('Authentication failed.');
  }

  async listPasskeysByUserId(userId: number): Promise<Partial<Passkey>[]> {
    const passkeys = await this.passkeyRepo.getPasskeysByUserId(userId);
    // 只返回部分信息以避免泄露敏感数据
    return passkeys.map(pk => ({
      credential_id: pk.credential_id,
      created_at: pk.created_at,
      last_used_at: pk.last_used_at,
      transports: pk.transports ? JSON.parse(pk.transports) : undefined,
      // 可以考虑添加一个用户可定义的名称字段
    }));
  }

  async deletePasskey(userId: number, credentialID: string): Promise<boolean> {
    const passkey = await this.passkeyRepo.getPasskeyByCredentialId(credentialID);
    if (!passkey) {
      throw new Error('Passkey not found.');
    }
    if (passkey.user_id !== userId) {
      // 安全措施：用户只能删除自己的 Passkey
      throw new Error('Unauthorized to delete this passkey.');
    }
    const wasDeleted = await this.passkeyRepo.deletePasskey(credentialID);
    return wasDeleted;
  }
}

export const passkeyService = new PasskeyService(passkeyRepository, userRepository);