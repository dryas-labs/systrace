// SPDX-License-Identifier: Apache-2.0
package BrakeSystem {
    private import SafetyExtensions::*;
    #safety requirement stopDistance {
        @Rationale { approvedBy = "Chief Engineer"; }
        :>> integrityLevel = 3;
    }
    #safety requirement brakeResponse {
        @Rationale { approvedBy = "Systems Lead"; }
    }
    requirement comfort;
}
