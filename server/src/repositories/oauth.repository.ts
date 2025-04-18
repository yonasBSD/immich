import { Injectable, InternalServerErrorException } from '@nestjs/common';
import { custom, generators, Issuer, UserinfoResponse } from 'openid-client';
import { LoggingRepository } from 'src/repositories/logging.repository';

export type OAuthConfig = {
  clientId: string;
  clientSecret: string;
  issuerUrl: string;
  mobileOverrideEnabled: boolean;
  mobileRedirectUri: string;
  profileSigningAlgorithm: string;
  scope: string;
  signingAlgorithm: string;
};
export type OAuthProfile = UserinfoResponse;

@Injectable()
export class OAuthRepository {
  constructor(private logger: LoggingRepository) {
    this.logger.setContext(OAuthRepository.name);
  }

  init() {
    custom.setHttpOptionsDefaults({ timeout: 30_000 });
  }

  async authorize(config: OAuthConfig, redirectUrl: string) {
    const client = await this.getClient(config);
    return client.authorizationUrl({
      redirect_uri: redirectUrl,
      scope: config.scope,
      state: generators.state(),
    });
  }

  async getLogoutEndpoint(config: OAuthConfig) {
    const client = await this.getClient(config);
    return client.issuer.metadata.end_session_endpoint;
  }

  async getProfile(config: OAuthConfig, url: string, redirectUrl: string): Promise<OAuthProfile> {
    const client = await this.getClient(config);
    const params = client.callbackParams(url);
    try {
      const tokens = await client.callback(redirectUrl, params, { state: params.state });
      const profile = await client.userinfo<OAuthProfile>(tokens.access_token || '');
      if (!profile.sub) {
        throw new Error('Unexpected profile response, no `sub`');
      }

      return profile;
    } catch (error: Error | any) {
      if (error.message.includes('unexpected JWT alg received')) {
        this.logger.warn(
          [
            'Algorithm mismatch. Make sure the signing algorithm is set correctly in the OAuth settings.',
            'Or, that you have specified a signing key in your OAuth provider.',
          ].join(' '),
        );
      }

      throw error;
    }
  }

  async getProfilePicture(url: string) {
    const response = await fetch(url);
    if (!response.ok) {
      throw new Error(`Failed to fetch picture: ${response.statusText}`);
    }

    return {
      data: await response.arrayBuffer(),
      contentType: response.headers.get('content-type'),
    };
  }

  private async getClient({
    issuerUrl,
    clientId,
    clientSecret,
    profileSigningAlgorithm,
    signingAlgorithm,
  }: OAuthConfig) {
    try {
      const issuer = await Issuer.discover(issuerUrl);
      return new issuer.Client({
        client_id: clientId,
        client_secret: clientSecret,
        response_types: ['code'],
        userinfo_signed_response_alg: profileSigningAlgorithm === 'none' ? undefined : profileSigningAlgorithm,
        id_token_signed_response_alg: signingAlgorithm,
      });
    } catch (error: any | AggregateError) {
      this.logger.error(`Error in OAuth discovery: ${error}`, error?.stack, error?.errors);
      throw new InternalServerErrorException(`Error in OAuth discovery: ${error}`, { cause: error });
    }
  }
}
