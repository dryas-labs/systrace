// SPDX-License-Identifier: Apache-2.0
package SafetyExtensions {
    private import Metaobjects::SemanticMetadata;
    private import ScalarValues::*;
    requirement def SafetyRequirement {
        attribute integrityLevel : Integer;
        attribute hazardRef : String;
    }
    requirement safetyRequirements : SafetyRequirement[*] nonunique;
    metadata def <safety> SafetyRequirementMetadata :> SemanticMetadata {
        :>> baseType = safetyRequirements meta SysML::Usage;
    }
    metadata def Rationale { attribute approvedBy : String; }
    metadata def Review {
        attribute reviewer : String;
        attribute approved : Boolean;
    }
}
