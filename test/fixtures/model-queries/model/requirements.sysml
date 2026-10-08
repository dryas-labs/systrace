// SPDX-License-Identifier: Apache-2.0
package DroneRequirements {
    private import Vehicle::*;
    requirement def MassRequirement {
        subject drone : Drone;
        attribute massLimit : ISQ::MassValue;
        require constraint { drone.mass <= massLimit }
    }
    requirement droneMass : MassRequirement;
    part droneInstance : Drone;
    satisfy droneMass by droneInstance;
}
