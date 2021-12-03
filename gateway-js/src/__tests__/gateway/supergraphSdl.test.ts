import {
  ApolloGateway,
  SubgraphHealthCheckFunction,
  SupergraphSdlUpdateFunction,
} from '@apollo/gateway';
import { fixturesWithUpdate } from 'apollo-federation-integration-testsuite';
import { createHash } from 'apollo-graphql/lib/utilities/createHash';
import { ApolloServer } from 'apollo-server';
import { Logger } from 'apollo-server-types';
import { fetch } from '../../__mocks__/apollo-server-env';
import { getTestingSupergraphSdl, waitUntil } from '../execution-utils';
import {
  mockAllServicesHealthCheckSuccess,
  mockAllServicesSdlQuerySuccess,
} from '../integration/nockMocks';

async function getSupergraphSdlGatewayServer() {
  const server = new ApolloServer({
    gateway: new ApolloGateway({
      supergraphSdl: getTestingSupergraphSdl(),
    }),
  });

  await server.listen({ port: 0 });
  return server;
}

let logger: Logger;
let gateway: ApolloGateway | null;
beforeEach(() => {
  logger = {
    debug: jest.fn(),
    info: jest.fn(),
    warn: jest.fn(),
    error: jest.fn(),
  };
});

afterEach(async () => {
  if (gateway) {
    await gateway.stop();
    gateway = null;
  }
});

describe('Using supergraphSdl static configuration', () => {
  it('successfully starts and serves requests to the proper services', async () => {
    const server = await getSupergraphSdlGatewayServer();

    fetch.mockJSONResponseOnce({
      data: { me: { username: '@jbaxleyiii' } },
    });

    const result = await server.executeOperation({
      query: '{ me { username } }',
    });

    expect(result.data).toMatchInlineSnapshot(`
      Object {
        "me": Object {
          "username": "@jbaxleyiii",
        },
      }
    `);

    const [url, request] = fetch.mock.calls[0];
    expect(url).toEqual('https://accounts.api.com');
    expect(request?.body).toEqual(
      JSON.stringify({ query: '{me{username}}', variables: {} }),
    );
    await server.stop();
  });
});

describe('Using supergraphSdl dynamic configuration', () => {
  it('calls the user provided function after `gateway.load()` is called', async () => {
    const callbackSpy = jest.fn(async () => ({
      supergraphSdl: getTestingSupergraphSdl(),
    }));

    const gateway = new ApolloGateway({
      supergraphSdl: callbackSpy,
    });

    expect(callbackSpy).not.toHaveBeenCalled();
    await gateway.load();
    expect(callbackSpy).toHaveBeenCalled();
  });

  it('starts and remains in `initialized` state until `supergraphSdl` Promise resolves', async () => {
    const [
      promiseGuaranteeingWeAreInTheCallback,
      resolvePromiseGuaranteeingWeAreInTheCallback,
    ] = waitUntil();
    const [
      promiseGuaranteeingWeStayInTheCallback,
      resolvePromiseGuaranteeingWeStayInTheCallback,
    ] = waitUntil();
    const gateway = new ApolloGateway({
      async supergraphSdl() {
        resolvePromiseGuaranteeingWeAreInTheCallback();
        await promiseGuaranteeingWeStayInTheCallback;
        return {
          supergraphSdl: getTestingSupergraphSdl(),
        };
      },
    });

    expect(gateway.__testing().state.phase).toEqual('initialized');

    const gatewayLoaded = gateway.load();
    await promiseGuaranteeingWeAreInTheCallback;
    expect(gateway.__testing().state.phase).toEqual('initialized');

    resolvePromiseGuaranteeingWeStayInTheCallback();
    await gatewayLoaded;
    expect(gateway.__testing().state.phase).toEqual('loaded');
  });

  it('moves from `initialized` to `loaded` state after calling `load()` and after user Promise resolves', async () => {
    const [userPromise, resolveSupergraph] =
      waitUntil<{ supergraphSdl: string }>();

    const gateway = new ApolloGateway({
      async supergraphSdl() {
        return userPromise;
      },
    });

    const loadPromise = gateway.load();
    expect(gateway.__testing().state.phase).toEqual('initialized');

    const supergraphSdl = getTestingSupergraphSdl();
    const expectedCompositionId = createHash('sha256')
      .update(supergraphSdl)
      .digest('hex');
    resolveSupergraph({ supergraphSdl });

    await loadPromise;
    const { state, compositionId } = gateway.__testing();
    expect(state.phase).toEqual('loaded');
    expect(compositionId).toEqual(expectedCompositionId);
  });

  it('updates its supergraph after user calls update function', async () => {
    const [userPromise, resolveSupergraph] =
      waitUntil<{ supergraphSdl: string }>();

    let userUpdateFn: SupergraphSdlUpdateFunction;
    const gateway = new ApolloGateway({
      async supergraphSdl({ update }) {
        userUpdateFn = update;
        return userPromise;
      },
    });

    const supergraphSdl = getTestingSupergraphSdl();
    const expectedId = createHash('sha256').update(supergraphSdl).digest('hex');
    resolveSupergraph({ supergraphSdl: getTestingSupergraphSdl() });
    await gateway.load();
    expect(gateway.__testing().compositionId).toEqual(expectedId);

    const updatedSupergraphSdl = getTestingSupergraphSdl(fixturesWithUpdate);
    const expectedUpdatedId = createHash('sha256')
      .update(updatedSupergraphSdl)
      .digest('hex');

    userUpdateFn!(updatedSupergraphSdl);
    expect(gateway.__testing().compositionId).toEqual(expectedUpdatedId);
  });

  it('calls user-provided `cleanup` function when stopped', async () => {
    const cleanup = jest.fn(() => Promise.resolve());
    const gateway = new ApolloGateway({
      async supergraphSdl() {
        return {
          supergraphSdl: getTestingSupergraphSdl(),
          cleanup,
        };
      },
    });

    await gateway.load();
    const { state, compositionId } = gateway.__testing();
    expect(state.phase).toEqual('loaded');
    expect(compositionId).toEqual(
      '562c22b3382b56b1651944a96e89a361fe847b9b32660eae5ecbd12adc20bf8b',
    );

    await gateway.stop();
    expect(cleanup).toHaveBeenCalledTimes(1);
  });

  it('performs a successful health check on subgraphs', async () => {
    mockAllServicesSdlQuerySuccess();
    mockAllServicesHealthCheckSuccess();

    let healthCheckCallback: SubgraphHealthCheckFunction;
    const supergraphSdl = getTestingSupergraphSdl();
    const gateway = new ApolloGateway({
      async supergraphSdl({ healthCheck }) {
        healthCheckCallback = healthCheck;
        return {
          supergraphSdl,
        };
      },
    });

    await gateway.load();
    const { state, compositionId } = gateway.__testing();
    expect(state.phase).toEqual('loaded');
    expect(compositionId).toEqual(
      '562c22b3382b56b1651944a96e89a361fe847b9b32660eae5ecbd12adc20bf8b',
    );

    await expect(healthCheckCallback!(supergraphSdl)).resolves.toBeUndefined();
  });

  describe('errors', () => {
    it('fails to load if user-provided `supergraphSdl` function throws', async () => {
      const failureMessage = 'Error from supergraphSdl function';
      const gateway = new ApolloGateway({
        async supergraphSdl() {
          throw new Error(failureMessage);
        },
        logger,
      });

      await expect(() => gateway.load()).rejects.toThrowError(failureMessage);

      expect(gateway.__testing().state.phase).toEqual('failed to load');
      expect(logger.error).toHaveBeenCalledWith(failureMessage);
    });

    it('gracefully handles Promise rejections from user `cleanup` function', async () => {
      const rejectionMessage = 'thrown from cleanup function';
      const cleanup = jest.fn(() => Promise.reject(rejectionMessage));
      const gateway = new ApolloGateway({
        async supergraphSdl() {
          return {
            supergraphSdl: getTestingSupergraphSdl(),
            cleanup,
          };
        },
        logger,
      });

      await gateway.load();
      await expect(gateway.stop()).resolves.toBeUndefined();
      expect(cleanup).toHaveBeenCalledTimes(1);
      expect(logger.error).toHaveBeenCalledWith(
        'Error occured while calling user provided `cleanup` function: ' +
          rejectionMessage,
      );
    });

    it('throws an error when `healthCheck` rejects', async () => {
      mockAllServicesSdlQuerySuccess();

      let healthCheckCallback: SubgraphHealthCheckFunction;
      const supergraphSdl = getTestingSupergraphSdl();
      const gateway = new ApolloGateway({
        async supergraphSdl({ healthCheck }) {
          healthCheckCallback = healthCheck;
          return {
            supergraphSdl,
          };
        },
      });

      await gateway.load();
      const { state, compositionId } = gateway.__testing();
      expect(state.phase).toEqual('loaded');
      expect(compositionId).toEqual(
        '562c22b3382b56b1651944a96e89a361fe847b9b32660eae5ecbd12adc20bf8b',
      );

      await expect(healthCheckCallback!(supergraphSdl)).rejects.toThrowError(
        /The gateway subgraphs health check failed\. Updating to the provided `supergraphSdl` will likely result in future request failures to subgraphs\. The following error occurred during the health check/,
      );
    });
  });
});