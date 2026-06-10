/*
Copyright 2026 Adobe. All rights reserved.
This file is licensed to you under the Apache License, Version 2.0 (the "License");
you may not use this file except in compliance with the License. You may obtain a copy
of the License at http://www.apache.org/licenses/LICENSE-2.0
Unless required by applicable law or agreed to in writing, software distributed under
the License is distributed on an "AS IS" BASIS, WITHOUT WARRANTIES OR REPRESENTATIONS
OF ANY KIND, either express or implied. See the License for the specific language
governing permissions and limitations under the License.
*/

class SandboxSDKError extends Error {
  constructor (message) {
    super(message)
    this.name = this.constructor.name
    if (Error.captureStackTrace) {
      Error.captureStackTrace(this, this.constructor)
    }
  }
}

class SandboxInitializationError extends SandboxSDKError {}
class SandboxClientError extends SandboxSDKError {}
class SandboxNotFoundError extends SandboxSDKError {}
class SandboxUnauthorizedError extends SandboxSDKError {}
class SandboxTimeoutError extends SandboxSDKError {}
class SandboxWebSocketError extends SandboxSDKError {}
class SandboxCommandNotFoundError extends SandboxSDKError {}
class SandboxPortNotProvisionedError extends SandboxSDKError {}
class SandboxInvalidPortError extends SandboxClientError {}
class ProtocolVersionMismatchError extends SandboxClientError {}

module.exports = {
  SandboxSDKError,
  SandboxInitializationError,
  SandboxClientError,
  SandboxNotFoundError,
  SandboxUnauthorizedError,
  SandboxTimeoutError,
  SandboxWebSocketError,
  SandboxCommandNotFoundError,
  SandboxPortNotProvisionedError,
  SandboxInvalidPortError,
  ProtocolVersionMismatchError
}
